// Starts a flock of birds on this machine from a scenario file, asks the entry
// bird questions, and reads the merged event logs back. Each bird lives in
// <directory>/<id>/ exactly as it would on its own machine.
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

export type Network = {
  entry: string
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
  return { entry: scenario.entry, nodes }
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

export async function askNetwork(
  network: Network,
  question: string,
  requestId: string = crypto.randomUUID(),
): Promise<{ answer: string; status: number }> {
  const response = await fetch(findNode(network.nodes, network.entry).url, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-hummingbirds-caller-id": "human",
      "x-hummingbirds-request-id": requestId,
    },
    body: question,
  })
  return { answer: await response.text(), status: response.status }
}

export async function stopNetwork(network: Network): Promise<void> {
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
