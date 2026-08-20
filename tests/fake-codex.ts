import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { headers, requireRecord, requireString } from "../src/protocol.ts"

type Peer = {
  address: string
  id: string
}

type Session = {
  peers: Peer[]
  threadId: string
}

if (process.argv.includes("--ephemeral")) throw new Error("Bird sessions must not be ephemeral")
if (!process.argv.includes("--json")) throw new Error("Fake Codex requires JSON mode")
if (!process.argv.includes('sandbox_mode="workspace-write"')) {
  throw new Error("Bird sessions require the network-enabled workspace sandbox")
}
if (Bun.env["HUMMINGBIRDS_EVENT_LOG_PATH"] !== undefined) {
  throw new Error("The archive event path must remain private to the Bun server")
}
if (Bun.env["HUMMINGBIRDS_THREAD_ID_PATH"] !== undefined) {
  throw new Error("The thread ID path must remain private to the Bun server")
}

const nodeId = requireEnvironment("HUMMINGBIRDS_NODE_ID")
const nodeAddress = requireEnvironment("HUMMINGBIRDS_NODE_ADDRESS")
const stateDirectory = requireEnvironment("HUMMINGBIRDS_FAKE_STATE_DIRECTORY")
const agents = await readFile("AGENTS.md", "utf8")
const question = await Bun.stdin.text()
const resumedThreadId = resumedSessionId()
const session =
  resumedThreadId === null
    ? { peers: parseInitialPeers(agents), threadId: crypto.randomUUID() }
    : await readSession(resumedThreadId)

const delayMs = readDelay()
if (delayMs > 0) await Bun.sleep(delayMs)

const privateAnswer = answerFromPrivateKnowledge(agents, question)
let answer: string
if (privateAnswer !== null) {
  answer = `${privateAnswer}\n\nContributors: ${nodeId} at ${nodeAddress}`
} else if (session.peers.length > 0 && question.includes("Nacre-")) {
  const peer = choosePeer(session.peers)
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
  learnContributors(session.peers, answer)
} else {
  answer = `Handled by ${nodeId}: ${question}`
}

await mkdir(stateDirectory, { recursive: true })
await writeFile(sessionPath(session.threadId), `${JSON.stringify(session, null, 2)}\n`)
await outputAnswer(answer, session.threadId)

function resumedSessionId(): string | null {
  const resumeIndex = process.argv.indexOf("resume")
  if (resumeIndex < 0) return null
  const prompt = process.argv.at(-1)
  const value = process.argv.at(-2)
  if (prompt !== "-" || value === undefined || value.length === 0) {
    throw new Error("Resume requires an exact session ID followed by stdin")
  }
  return value
}

async function readSession(expectedThreadId: string): Promise<Session> {
  const record = requireRecord(
    JSON.parse(await readFile(sessionPath(expectedThreadId), "utf8")),
    "fake session",
  )
  const rawPeers = record["peers"]
  if (!Array.isArray(rawPeers)) throw new Error("fake session peers must be an array")
  const peers = rawPeers.map((value) => {
    const peer = requireRecord(value, "fake session peer")
    return { address: requireString(peer, "address"), id: requireString(peer, "id") }
  })
  const storedThreadId = requireString(record, "threadId")
  if (storedThreadId !== expectedThreadId) throw new Error("Fake Codex resumed the wrong session")
  return { peers, threadId: storedThreadId }
}

function sessionPath(value: string): string {
  return join(stateDirectory, `${value}.json`)
}

function parseInitialPeers(text: string): Peer[] {
  const peers: Peer[] = []
  const pattern = /^- ([A-Za-z0-9_-]+) at (http:\/\/\S+\/ask)$/gm
  for (const match of text.matchAll(pattern)) {
    const id = match[1]
    const address = match[2]
    if (id === undefined || address === undefined) throw new Error("Invalid initial peer")
    peers.push({ address, id })
  }
  return peers
}

function answerFromPrivateKnowledge(text: string, incomingQuestion: string): string | null {
  const trial = /(Nacre-[A-Z])/.exec(incomingQuestion)?.[1]
  if (trial === undefined) return null
  const line = text.split("\n").find((candidate) => candidate.includes(trial))
  if (line === undefined) return null
  return /“([^”]+)”/.exec(line)?.[1] ?? null
}

function choosePeer(peers: Peer[]): Peer {
  return peers.find((peer) => peer.id === "c") ?? requireFirst(peers)
}

function requireFirst<T>(values: T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error("Expected a peer")
  return value
}

function learnContributors(peers: Peer[], response: string): void {
  const pattern = /Contributors?: ([A-Za-z0-9_-]+) at (http:\/\/\S+\/ask)/g
  for (const match of response.matchAll(pattern)) {
    const id = match[1]
    const address = match[2]
    if (id === undefined || address === undefined) throw new Error("Invalid contributor")
    const existing = peers.find((peer) => peer.id === id)
    if (existing === undefined) peers.push({ address, id })
    else existing.address = address
  }
}

async function outputAnswer(value: string, activeThreadId: string): Promise<void> {
  const optionIndex = process.argv.indexOf("--output-last-message")
  const outputPath = process.argv[optionIndex + 1]
  if (optionIndex < 0 || outputPath === undefined) {
    throw new Error("JSON mode requires --output-last-message")
  }
  await writeFile(outputPath, value)
  const events = [
    { thread_id: activeThreadId, type: "thread.started" },
    {
      item: { id: crypto.randomUUID(), text: value, type: "agent_message" },
      type: "item.completed",
    },
    { type: "turn.completed", usage: { cached_input_tokens: 0, input_tokens: 1, output_tokens: 1 } },
  ]
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)
}

function readDelay(): number {
  const raw = Bun.env["HUMMINGBIRDS_FAKE_DELAY_MS"]
  if (raw === undefined) return 0
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid fake delay")
  return value
}

function requireEnvironment(name: string): string {
  const value = Bun.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}
