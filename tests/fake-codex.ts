#!/usr/bin/env bun
// A stand-in for the `codex` CLI so the flock can be tested offline. It speaks
// just enough of `codex exec --json`: it answers from the "ledger" lines in its
// AGENTS.md, otherwise asks a peer, and remembers peers it learns about across
// resumed sessions (stored as .fake-codex/<thread-id>.json in its workspace).
// A message with a Reply-to address is answered by POSTing there, and peers are
// then asked the same way; replies that come back are relayed to whoever asked.
import { appendFile, mkdir, readFile, writeFile } from "fs/promises"
import { join } from "path"

type Peer = { address: string; id: string }
type Session = { peers: Peer[]; pending: Record<string, string>; threadId: string }

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

let answer: string
const inReplyTo = envelope["Re"]
const replyTo = envelope["Reply-to"]
if (inReplyTo !== undefined) {
  // A peer answered something we asked on someone's behalf: pass it along.
  const askedBy = session.pending[inReplyTo]
  if (askedBy === undefined) throw new Error(`Unexpected reply to ${inReplyTo}`)
  delete session.pending[inReplyTo]
  learnContributors(session.peers, question)
  await post(askedBy, question, { "x-hummingbirds-in-reply-to": inReplyTo })
  answer = "" // Like the real Codex, nothing more to say after POSTing the reply.
} else {
  const requestId = envelope["Request"] ?? ""
  const privateAnswer = answerFromPrivateKnowledge(agents, question)
  let found: string | null = null
  if (privateAnswer !== null) {
    found = `${privateAnswer}\n\nContributors: ${nodeId} at ${nodeAddress}`
  } else if (session.peers.length > 0 && question.includes("Nacre-")) {
    const peer = session.peers.find((candidate) => candidate.id === "c") ?? session.peers[0]
    if (peer === undefined) throw new Error("Expected a peer")
    if (replyTo === undefined) {
      found = await post(peer.address, question, {})
      learnContributors(session.peers, found)
    } else {
      session.pending[requestId] = replyTo
      await post(peer.address, question, { "x-hummingbirds-reply-to": nodeAddress })
    }
  } else {
    found = `Handled by ${nodeId}: ${question}`
  }
  if (found === null) answer = `Asked a peer about ${requestId}; waiting.`
  else if (replyTo === undefined) answer = found
  else {
    await post(replyTo, found, { "x-hummingbirds-in-reply-to": requestId })
    answer = ""
  }
}
if (Bun.env["HUMMINGBIRDS_FAKE_SILENT"] === "1") answer = ""

await mkdir(".fake-codex", { recursive: true })
await writeFile(sessionPath(session.threadId), `${JSON.stringify(session, null, 2)}\n`)
await appendFile(join(".fake-codex", "argv.jsonl"), `${JSON.stringify(process.argv.slice(2))}\n`)
const events = [
  { thread_id: session.threadId, type: "thread.started" },
  { item: { id: "item_0", text: answer, type: "agent_message" }, type: "item.completed" },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
]
process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)

// POST like the prompt tells a bird to, expecting 200 when waiting and 202 otherwise.
async function post(address: string, body: string, extra: Record<string, string>): Promise<string> {
  const response = await fetch(address, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-hummingbirds-caller-id": nodeId,
      "x-hummingbirds-invocation-id": crypto.randomUUID(),
      "x-hummingbirds-parent-invocation-id": Bun.env["HUMMINGBIRDS_INVOCATION_ID"] ?? "",
      "x-hummingbirds-path": Bun.env["HUMMINGBIRDS_PATH"] ?? "[]",
      "x-hummingbirds-request-id": Bun.env["HUMMINGBIRDS_REQUEST_ID"] ?? "",
      ...extra,
    },
    body,
  })
  const text = await response.text()
  const expected = Object.keys(extra).length === 0 ? 200 : 202
  if (response.status !== expected) {
    throw new Error(`${address} returned ${response.status} instead of ${expected}: ${text}`)
  }
  return text
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
