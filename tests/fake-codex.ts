#!/usr/bin/env bun
// A stand-in for the `codex` CLI so the flock can be tested offline. It speaks
// just enough of `codex exec --json`: it answers from the "ledger" lines in its
// AGENTS.md, otherwise asks a peer, and remembers peers it learns about across
// resumed sessions (stored as .fake-codex/<thread-id>.json in its workspace).
import { appendFile, mkdir, readFile, writeFile } from "fs/promises"
import { join } from "path"

type Peer = { address: string; id: string }
type Session = { peers: Peer[]; threadId: string }

const nodeId = Bun.env["HUMMINGBIRDS_NODE_ID"] ?? ""
const nodeAddress = Bun.env["HUMMINGBIRDS_NODE_ADDRESS"] ?? ""
const agents = await readFile("AGENTS.md", "utf8")
const question = await Bun.stdin.text()
const resumeIndex = process.argv.indexOf("resume")
const resumedThreadId = resumeIndex < 0 ? null : (process.argv.at(-2) ?? null)
const session: Session =
  resumedThreadId === null
    ? { peers: parseInitialPeers(agents), threadId: crypto.randomUUID() }
    : (JSON.parse(await readFile(sessionPath(resumedThreadId), "utf8")) as Session)

const delayMs = Number(Bun.env["HUMMINGBIRDS_FAKE_DELAY_MS"] ?? 0)
if (delayMs > 0) await Bun.sleep(delayMs)

const privateAnswer = answerFromPrivateKnowledge(agents, question)
let answer: string
if (privateAnswer !== null) {
  answer = `${privateAnswer}\n\nContributors: ${nodeId} at ${nodeAddress}`
} else if (session.peers.length > 0 && question.includes("Nacre-")) {
  const peer = session.peers.find((candidate) => candidate.id === "c") ?? session.peers[0]
  if (peer === undefined) throw new Error("Expected a peer")
  const response = await fetch(peer.address, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-hummingbirds-caller-id": nodeId,
      "x-hummingbirds-invocation-id": crypto.randomUUID(),
      "x-hummingbirds-parent-invocation-id": Bun.env["HUMMINGBIRDS_INVOCATION_ID"] ?? "",
      "x-hummingbirds-path": Bun.env["HUMMINGBIRDS_PATH"] ?? "[]",
      "x-hummingbirds-request-id": Bun.env["HUMMINGBIRDS_REQUEST_ID"] ?? "",
    },
    body: question,
  })
  answer = await response.text()
  if (!response.ok) throw new Error(`Peer ${peer.id} returned ${response.status}: ${answer}`)
  learnContributors(session.peers, answer)
} else {
  answer = `Handled by ${nodeId}: ${question}`
}

await mkdir(".fake-codex", { recursive: true })
await writeFile(sessionPath(session.threadId), `${JSON.stringify(session, null, 2)}\n`)
await appendFile(join(".fake-codex", "argv.jsonl"), `${JSON.stringify(process.argv.slice(2))}\n`)
const events = [
  { thread_id: session.threadId, type: "thread.started" },
  { item: { id: "item_0", text: answer, type: "agent_message" }, type: "item.completed" },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
]
process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)

function sessionPath(threadId: string): string {
  return join(".fake-codex", `${threadId}.json`)
}

function parseInitialPeers(text: string): Peer[] {
  return [...text.matchAll(/^- ([A-Za-z0-9_-]+) at (http:\/\/\S+\/ask)$/gm)].map((match) => ({
    address: match[2] ?? "",
    id: match[1] ?? "",
  }))
}

function answerFromPrivateKnowledge(text: string, incomingQuestion: string): string | null {
  const trial = /(Nacre-[A-Z])/.exec(incomingQuestion)?.[1]
  if (trial === undefined) return null
  const line = text.split("\n").find((candidate) => candidate.includes(trial))
  if (line === undefined) return null
  return /“([^”]+)”/.exec(line)?.[1] ?? null
}

function learnContributors(peers: Peer[], response: string): void {
  for (const match of response.matchAll(
    /Contributors?: ([A-Za-z0-9_-]+) at (http:\/\/\S+\/ask)/g,
  )) {
    const id = match[1] ?? ""
    const address = match[2] ?? ""
    const existing = peers.find((peer) => peer.id === id)
    if (existing === undefined) peers.push({ address, id })
    else existing.address = address
  }
}
