#!/usr/bin/env bun
// A stand-in for the `codex` CLI so the flock can be tested offline. It speaks
// just enough of `codex exec --json`: it answers from the "ledger" lines in its
// AGENTS.md, otherwise asks a peer, and remembers peers it learns about across
// resumed sessions (stored as .fake-codex/<thread-id>.json in its workspace).
// Like a real bird, it POSTs answers to the message's Reply-to address, asks peers
// with its own address as Reply-to, and relays their replies to whoever asked.
import { appendFile, mkdir, readFile, writeFile } from "fs/promises"
import { join } from "path"

type Peer = { address: string; id: string }
type Session = { peers: Peer[]; pending: Record<string, string | null>; threadId: string }

const nodeId = Bun.env["HUMMINGBIRDS_NODE_ID"] ?? ""
const nodeAddress = Bun.env["HUMMINGBIRDS_NODE_ADDRESS"] ?? ""
const agents = await readFile("AGENTS.md", "utf8")
const message = await Bun.stdin.text()
const separator = message.indexOf("\n\n")
if (separator < 0) throw new Error(`Message without an envelope: ${message}`)
const envelope = Object.fromEntries(
  message
    .slice(0, separator)
    .split("\n")
    .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
) as Record<string, string | undefined>
const question = message.slice(separator + 2)
const resumeIndex = process.argv.indexOf("resume")
const resumedThreadId = resumeIndex < 0 ? null : (process.argv.at(-2) ?? null)
const session: Session =
  resumedThreadId === null
    ? { peers: parseInitialPeers(agents), pending: {}, threadId: crypto.randomUUID() }
    : (JSON.parse(await readFile(sessionPath(resumedThreadId), "utf8")) as Session)

const delayMs = Number(Bun.env["HUMMINGBIRDS_FAKE_DELAY_MS"] ?? 0)
if (delayMs > 0) await Bun.sleep(delayMs)
emit({ thread_id: session.threadId, type: "thread.started" })
let nextItemId = 0

// Like the real Codex, the final message goes nowhere; only the POSTs matter.
let answer = ""
const inReplyTo = envelope["Re"]
if (inReplyTo !== undefined) {
  // A peer answered something we asked on someone's behalf: pass it along.
  if (!Object.hasOwn(session.pending, inReplyTo)) {
    throw new Error(`Unexpected reply to ${inReplyTo}`)
  }
  const askedBy = session.pending[inReplyTo] ?? null
  delete session.pending[inReplyTo]
  learnContributors(session.peers, question)
  if (askedBy === null) answer = question
  else await post(askedBy, question, inReplyTo)
} else {
  const requestId = envelope["Request"] ?? ""
  const replyTo = envelope["Reply-to"]
  const privateAnswer = answerFromPrivateKnowledge(agents, question)
  let found: string | null = null
  if (privateAnswer !== null) {
    found = `${privateAnswer}\n\nContributors: ${nodeId} at ${nodeAddress}`
  } else if (session.peers.length > 0 && question.includes("Nacre-")) {
    const peer = session.peers.find((candidate) => candidate.id === "c") ?? session.peers[0]
    if (peer === undefined) throw new Error("Expected a peer")
    session.pending[requestId] = replyTo ?? null
    await post(peer.address, question, null)
    answer = `Asked ${peer.id} about ${requestId}; waiting.`
  } else {
    found = `Handled by ${nodeId}: ${question}`
  }
  // No Reply-to means nobody is expecting an answer; the closing words only get logged.
  if (found !== null && replyTo !== undefined) await post(replyTo, found, requestId)
  else if (found !== null) answer = found
}

await mkdir(".fake-codex", { recursive: true })
await writeFile(sessionPath(session.threadId), `${JSON.stringify(session, null, 2)}\n`)
await appendFile(join(".fake-codex", "argv.jsonl"), `${JSON.stringify(process.argv.slice(2))}\n`)
emit({
  item: { id: `item_${nextItemId}`, text: answer, type: "agent_message" },
  type: "item.completed",
})
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })

// POST like the prompt tells a bird to: a question when inReplyTo is null, a reply
// otherwise. Either way the other side only acknowledges.
async function post(address: string, body: string, inReplyTo: string | null): Promise<void> {
  const command = `/bin/zsh -lc "curl -sS -X POST '${address}' --data-binary '${body.replaceAll("'", "'\\''")}'"`
  const item = {
    id: `item_${nextItemId++}`,
    type: "command_execution",
    command,
    aggregated_output: "",
    exit_code: null,
    status: "in_progress",
  }
  emit({ type: "item.started", item })
  const response = await fetch(address, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-hummingbirds-caller-id": nodeId,
      "x-hummingbirds-invocation-id": crypto.randomUUID(),
      "x-hummingbirds-parent-invocation-id": Bun.env["HUMMINGBIRDS_INVOCATION_ID"] ?? "",
      "x-hummingbirds-path": Bun.env["HUMMINGBIRDS_PATH"] ?? "[]",
      "x-hummingbirds-reply-to": nodeAddress,
      "x-hummingbirds-request-id": Bun.env["HUMMINGBIRDS_REQUEST_ID"] ?? "",
      ...(inReplyTo === null ? {} : { "x-hummingbirds-in-reply-to": inReplyTo }),
    },
    body,
  })
  const text = await response.text()
  emit({
    type: "item.completed",
    item: { ...item, aggregated_output: text, exit_code: 0, status: "completed" },
  })
  if (response.status !== 202) {
    throw new Error(`${address} returned ${response.status} instead of 202: ${text}`)
  }
}

function emit(event: object): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

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
