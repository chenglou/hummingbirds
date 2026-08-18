import { readFile, writeFile } from "node:fs/promises"

import { headers } from "../src/protocol.ts"

const nodeId = requireEnvironment("HUMMINGBIRDS_NODE_ID")
const nodeAddress = requireEnvironment("HUMMINGBIRDS_NODE_ADDRESS")
const question = await Bun.stdin.text()
let answer: string

if (nodeId === "c") {
  const phrase = question.includes("Nacre-B") ? "Violet Shoal-862." : "Amber Tern-417."
  answer = `${phrase}\n\nContributors: c at ${nodeAddress}`
} else {
  const nodes = await readFile("nodes.md", "utf8")
  const peer = choosePeer(nodes, nodeId, question)
  const response = await fetch(peer.address, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      [headers.callerId]: nodeId,
      [headers.invocationId]: crypto.randomUUID(),
      [headers.parentInvocationId]: requireEnvironment("HUMMINGBIRDS_INVOCATION_ID"),
      [headers.path]: requireEnvironment("HUMMINGBIRDS_PATH"),
      [headers.requestId]: requireEnvironment("HUMMINGBIRDS_REQUEST_ID"),
    },
    body: question,
  })
  answer = await response.text()
  if (!response.ok) throw new Error(`Peer ${peer.id} returned ${response.status}: ${answer}`)

  const contributorAddress = requireMatch(answer, /Contributors: c at (http:\/\/\S+\/ask)/, "c")
  await writeFile(
    "nodes.md",
    renderLearnedNodes(nodes, nodeId, peer, contributorAddress),
  )
  await rememberAnswer(question, answer)
}

await outputAnswer(answer)

async function outputAnswer(value: string): Promise<void> {
  if (!process.argv.includes("--json")) {
    process.stdout.write(value)
    return
  }

  const optionIndex = process.argv.indexOf("--output-last-message")
  const outputPath = process.argv[optionIndex + 1]
  if (optionIndex < 0 || outputPath === undefined) {
    throw new Error("JSON mode requires --output-last-message")
  }
  await writeFile(outputPath, value)
  const events = [
    { thread_id: `fixture-${crypto.randomUUID()}`, type: "thread.started" },
    {
      item: { id: crypto.randomUUID(), text: value, type: "agent_message" },
      type: "item.completed",
    },
    { type: "turn.completed", usage: { cached_input_tokens: 0, input_tokens: 1, output_tokens: 1 } },
  ]
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)
}

function choosePeer(
  nodes: string,
  currentNodeId: string,
  incomingQuestion: string,
): { address: string; id: string } {
  if (currentNodeId === "a" && incomingQuestion.includes("Nacre-B")) {
    const address = addressOf(nodes, "c")
    if (address !== null) return { address, id: "c" }
  }
  const match = /- ([A-Za-z0-9_-]+) at (http:\/\/\S+\/ask) —/.exec(nodes)
  if (match?.[1] === undefined || match[2] === undefined) throw new Error("No known peer")
  return { id: match[1], address: match[2] }
}

function renderLearnedNodes(
  previous: string,
  currentNodeId: string,
  peer: { address: string; id: string },
  contributorAddress: string,
): string {
  if (currentNodeId === "b") {
    return `# Known nodes\n\n- c at ${contributorAddress} — answered pelagic-lichen ledger questions.\n`
  }
  const bAddress = addressOf(previous, "b")
  if (bAddress === null) throw new Error("a lost b")
  const cDescription =
    peer.id === "c"
      ? "directly answered pelagic-lichen ledger questions."
      : "answered pelagic-lichen ledger questions, learned via b."
  return `# Known nodes\n\n- b at ${bAddress} — successfully relayed pelagic-lichen ledger questions.\n- c at ${contributorAddress} — ${cDescription}\n`
}

async function rememberAnswer(incomingQuestion: string, answer: string): Promise<void> {
  const trial = requireMatch(incomingQuestion, /(Nacre-[AB])/, "trial")
  const phrase = requireMatch(answer, /^([^\n]+)/, "answer")
  const knowledge = await readFile("knowledge.md", "utf8")
  if (knowledge.includes(trial)) return
  const separator = knowledge.endsWith("\n") ? "" : "\n"
  await writeFile(
    "knowledge.md",
    `${knowledge}${separator}\n- ${trial} records the exact harbor phrase “${phrase}”\n`,
  )
}

function addressOf(nodes: string, id: string): string | null {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`- ${escapedId} at (http:\\/\\/\\S+\\/ask) —`).exec(nodes)?.[1] ?? null
}

function requireMatch(text: string, pattern: RegExp, label: string): string {
  const value = pattern.exec(text)?.[1]
  if (value === undefined) throw new Error(`Could not find ${label}`)
  return value
}

function requireEnvironment(name: string): string {
  const value = Bun.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}
