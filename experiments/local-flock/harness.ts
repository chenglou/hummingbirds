// Starts a flock of birds on this machine from a scenario file, runs an inbox the
// birds reply to, asks the entry bird questions, and reads the merged event logs
// back. Each bird lives in <directory>/<id>/ exactly as it would on its own machine.
import { mkdir, readdir, readFile, writeFile } from "fs/promises"
import { join, resolve } from "path"

import type { Event } from "../../src/server.ts"

type Scenario = {
  entry: string
  nodes: { id: string; peers: string[]; seed: string }[]
}

export type Node = {
  directory: string
  id: string
  process: Bun.Subprocess<"ignore", "pipe", "pipe">
  url: string
}

// A message a bird POSTed to the human's inbox.
export type InboxMessage = {
  at: number
  body: string
  from: string
  inReplyTo: string | null
}

export type Inbox = {
  messages: InboxMessage[]
  stop: () => void
  url: string
}

export type Network = {
  directory: string
  entry: string
  inbox: Inbox
  nodes: Node[]
}

const serverPath = resolve(import.meta.dir, "../../src/server.ts")
const promptPath = resolve(import.meta.dir, "../../src/prompt_template.md")

export async function startNetwork(
  scenarioPath: string,
  directory: string,
  env: Record<string, string> = {},
): Promise<Network> {
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as Scenario
  validate(scenario)
  const prompt = await readFile(promptPath, "utf8")
  const nodes = await Promise.all(
    scenario.nodes.map((seed) => spawnNode(join(directory, seed.id), env)),
  )
  for (const seed of scenario.nodes) {
    const node = findNode(nodes, seed.id)
    const peers = seed.peers
      .map((id) => findNode(nodes, id))
      .map((peer) => `- ${peer.id} at ${peer.url}`)
      .join("\n")
    await writeFile(
      join(node.directory, "workspace", "AGENTS.md"),
      prompt
        .replaceAll("[id]", node.id)
        .replaceAll("[address]", node.url)
        .replaceAll("[peers]", peers === "" ? "(none)" : peers)
        .replaceAll("[seed]", seed.seed === "" ? "(none)" : seed.seed),
    )
  }
  return { directory: resolve(directory), entry: scenario.entry, inbox: startInbox(), nodes }
}

export async function spawnNode(
  directory: string,
  env: Record<string, string> = {},
  port = 0,
): Promise<Node> {
  await mkdir(directory, { recursive: true })
  const child = Bun.spawn([process.execPath, "run", serverPath], {
    cwd: directory,
    env: { ...process.env, ...env, HUMMINGBIRDS_PORT: String(port) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const ready = JSON.parse(await readLine(child.stdout)) as { id: string; url: string }
    return { directory: resolve(directory), id: ready.id, process: child, url: ready.url }
  } catch (error) {
    child.kill()
    const stderr = await new Response(child.stderr).text()
    throw new Error(`Bird in ${directory} failed to start: ${String(error)}\n${stderr}`)
  }
}

// The human as a node: an address birds can POST replies to.
function startInbox(): Inbox {
  const messages: InboxMessage[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.text()
      if (body.trim() === "") return new Response("Empty message.", { status: 400 })
      messages.push({
        at: Date.now(),
        body,
        from: request.headers.get("x-hummingbirds-caller-id") ?? "unknown",
        inReplyTo: request.headers.get("x-hummingbirds-in-reply-to"),
      })
      return new Response("Accepted by human.", { status: 202 })
    },
  })
  return {
    messages,
    stop: () => void server.stop(true),
    url: `http://127.0.0.1:${server.port}/inbox`,
  }
}

// The entry bird gets the inbox as Reply-to and answers 202 right away. Resolves once
// no bird has anything left to do, or at the timeout (settled: false), with whatever
// replies reached the inbox for this request.
export async function askNetwork(
  network: Network,
  question: string,
  requestId: string = crypto.randomUUID(),
  timeoutMs = 600_000,
): Promise<{ replies: InboxMessage[]; settled: boolean; status: number }> {
  const response = await fetch(findNode(network.nodes, network.entry).url, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-hummingbirds-caller-id": "human",
      "x-hummingbirds-reply-to": network.inbox.url,
      "x-hummingbirds-request-id": requestId,
    },
    body: question,
  })
  const status = response.status
  if (status !== 202)
    return {
      replies: [
        { at: Date.now(), body: await response.text(), from: network.entry, inReplyTo: null },
      ],
      settled: true,
      status,
    }
  const settled = await waitUntilIdle(network, timeoutMs)
  return {
    replies: network.inbox.messages.filter((message) => message.inReplyTo === requestId),
    settled,
    status,
  }
}

// True once every request a bird received has been rejected, completed or failed.
// A bird records a request before answering 202, so nothing can be in flight either,
// unless a bird ended its turn without waiting for that 202; hence two quiet polls.
export async function waitUntilIdle(network: Network, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let quiet = 0
  for (;;) {
    const trace = await readTrace(network.directory)
    const open = trace.filter((event) => event.kind === "received").length
    const done = trace.filter(
      (event) => event.kind === "rejected" || event.kind === "completed" || event.kind === "failed",
    ).length
    quiet = open === done ? quiet + 1 : 0
    if (quiet === 2) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(250)
  }
}

export async function stopNetwork(network: Network): Promise<void> {
  network.inbox.stop()
  for (const node of network.nodes) node.process.kill()
  await Promise.all(network.nodes.map((node) => node.process.exited))
}

// Every bird's events, merged in time order.
export async function readTrace(
  directory: string,
  requestId: string | null = null,
): Promise<Event[]> {
  const events: Event[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = Bun.file(join(directory, entry.name, "events.jsonl"))
    if (!(await file.exists())) continue
    for (const line of (await file.text()).split("\n")) {
      if (line === "") continue
      const event = JSON.parse(line) as Event
      if (requestId === null || event.requestId === requestId) events.push(event)
    }
  }
  return events.sort(
    (left, right) =>
      left.at - right.at || left.nodeId.localeCompare(right.nodeId) || left.seq - right.seq,
  )
}

// Check the scenario before any bird starts, so a typo can't leave servers running.
function validate(scenario: Scenario): void {
  const ids = new Set<string>()
  for (const node of scenario.nodes) {
    if (!/^[A-Za-z0-9_-]+$/.test(node.id)) throw new Error(`Invalid node ID: ${node.id}`)
    if (ids.has(node.id)) throw new Error(`Duplicate node ID: ${node.id}`)
    ids.add(node.id)
  }
  for (const node of scenario.nodes) {
    for (const peer of node.peers) {
      if (!ids.has(peer)) throw new Error(`Unknown peer ${peer} of node ${node.id}`)
    }
  }
  if (!ids.has(scenario.entry)) throw new Error(`Unknown entry node: ${scenario.entry}`)
}

function findNode(nodes: Node[], id: string): Node {
  const node = nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`Unknown node: ${id}`)
  return node
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error("exited before announcing its address")
      text += decoder.decode(value, { stream: true })
      const end = text.indexOf("\n")
      if (end >= 0) return text.slice(0, end)
    }
  } finally {
    reader.releaseLock()
  }
}
