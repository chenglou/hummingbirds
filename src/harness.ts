import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import {
  headers,
  requireNumber,
  requireRecord,
  requireString,
  type TraceEvent,
} from "./protocol.ts"
import { parseReadyMessage, parseTraceEvent } from "./trace.ts"

export type NodeSeed = {
  id: string
  peers: string[]
  seed: string
}

export type Scenario = {
  entry: string
  nodes: NodeSeed[]
}

export type RunningNode = {
  directory: string
  id: string
  pid: number
  process: Bun.Subprocess<"ignore", "pipe", "pipe">
  url: string
}

export type RunningNetwork = {
  entry: string
  nodes: RunningNode[]
  runDirectory: string
}

export type AskResult = {
  answer: string
  invocationId: string
  requestId: string
  status: number
}

type NodeEndpoint = {
  id: string
  pid: number
  url: string
}

type RunManifest = {
  entry: string
  nodes: NodeEndpoint[]
}

type SpawnedNode = {
  directory: string
  id: string
  process: Bun.Subprocess<"ignore", "pipe", "pipe">
}

const sourceDirectory = import.meta.dir

export async function loadScenario(path: string): Promise<Scenario> {
  const scenario = parseScenario(parseJson(await readFile(path, "utf8")))
  validateScenario(scenario)
  return scenario
}

export async function startNetwork(
  scenarioPath: string,
  runDirectory: string,
  environment: Record<string, string> = {},
): Promise<RunningNetwork> {
  const absoluteScenarioPath = resolve(scenarioPath)
  const absoluteRunDirectory = resolve(runDirectory)
  const scenario = await loadScenario(absoluteScenarioPath)
  const prompt = await readFile(join(sourceDirectory, "prompt.md"), "utf8")

  await mkdir(dirname(absoluteRunDirectory), { recursive: true })
  await mkdir(absoluteRunDirectory)

  await Promise.all(
    scenario.nodes.map(async (seed) => {
      const directory = join(absoluteRunDirectory, seed.id)
      await mkdir(directory)
      await Promise.all([
        copyFile(join(sourceDirectory, "agent.ts"), join(directory, "agent.ts")),
        copyFile(join(sourceDirectory, "protocol.ts"), join(directory, "protocol.ts")),
        copyFile(join(sourceDirectory, "prompt.md"), join(directory, "prompt.md")),
        copyFile(join(sourceDirectory, "server.ts"), join(directory, "server.ts")),
        writeFile(join(directory, "events.jsonl"), ""),
      ])
    }),
  )

  const spawned = scenario.nodes.map((seed) =>
    spawnNode(seed.id, join(absoluteRunDirectory, seed.id), environment),
  )

  let nodes: RunningNode[]
  try {
    nodes = await Promise.all(spawned.map(readReady))
  } catch (error) {
    await stopSpawned(spawned)
    throw error
  }

  try {
    await Promise.all(
      scenario.nodes.map(async (seed) => {
        const peers = seed.peers.map((peerId) => findNode(nodes, peerId))
        const node = findNode(nodes, seed.id)
        await writeFile(
          join(absoluteRunDirectory, seed.id, "AGENTS.md"),
          renderNodePrompt(prompt, node, peers, seed.seed),
        )
      }),
    )

    const manifest: RunManifest = {
      entry: scenario.entry,
      nodes: nodes.map(({ id, pid, url }) => ({ id, pid, url })),
    }
    await writeFile(join(absoluteRunDirectory, "network.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    return { entry: scenario.entry, nodes, runDirectory: absoluteRunDirectory }
  } catch (error) {
    await stopNetwork({ entry: scenario.entry, nodes, runDirectory: absoluteRunDirectory })
    throw error
  }
}

export async function askNetwork(
  network: RunningNetwork,
  question: string,
  requestId: string = crypto.randomUUID(),
): Promise<AskResult> {
  const entry = findNode(network.nodes, network.entry)
  const invocationId = crypto.randomUUID()
  const response = await fetch(entry.url, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      [headers.callerId]: "human",
      [headers.invocationId]: invocationId,
      [headers.path]: "[]",
      [headers.requestId]: requestId,
    },
    body: question,
  })
  const responseRequestId = response.headers.get(headers.requestId)
  if (responseRequestId !== requestId) throw new Error("Entry node did not preserve the request ID")
  const responseInvocationId = response.headers.get(headers.invocationId)
  if (responseInvocationId !== invocationId) {
    throw new Error("Entry node did not preserve the invocation ID")
  }
  const contentType = response.headers.get("content-type")
  if (contentType === null || !contentType.startsWith("text/plain")) {
    throw new Error("Entry node did not return plain text")
  }
  return {
    answer: await response.text(),
    invocationId: responseInvocationId,
    requestId: responseRequestId,
    status: response.status,
  }
}

export async function stopNetwork(network: RunningNetwork): Promise<void> {
  for (const node of network.nodes) node.process.kill()
  await Promise.all(network.nodes.map((node) => node.process.exited))
}

export async function readTrace(
  runDirectory: string,
  requestId: string | null = null,
): Promise<TraceEvent[]> {
  const absoluteRunDirectory = resolve(runDirectory)
  const manifest = parseManifest(
    parseJson(await readFile(join(absoluteRunDirectory, "network.json"), "utf8")),
  )
  const eventGroups = await Promise.all(
    manifest.nodes.map(async (node) => {
      const text = await readFile(join(absoluteRunDirectory, node.id, "events.jsonl"), "utf8")
      const events: TraceEvent[] = []
      for (const line of text.split("\n")) {
        if (line.length === 0) continue
        const event = parseTraceEvent(parseJson(line))
        if (requestId === null || event.requestId === requestId) events.push(event)
      }
      return events
    }),
  )
  const events = eventGroups.flat()
  events.sort(
    (left, right) =>
      left.at - right.at || left.nodeId.localeCompare(right.nodeId) || left.seq - right.seq,
  )
  return events
}

function spawnNode(
  id: string,
  directory: string,
  environment: Record<string, string>,
): SpawnedNode {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "server.ts"],
    cwd: directory,
    env: {
      ...process.env,
      ...environment,
      HUMMINGBIRDS_NODE_ID: id,
      HUMMINGBIRDS_PORT: "0",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  return { directory, id, process: child }
}

async function readReady(spawned: SpawnedNode): Promise<RunningNode> {
  try {
    const line = await withTimeout(readFirstLine(spawned.process.stdout), 10_000)
    const ready = parseReadyMessage(parseJson(line))
    if (ready.id !== spawned.id) {
      throw new Error(`Node ${spawned.id} announced itself as ${ready.id}`)
    }
    if (ready.pid !== spawned.process.pid) {
      throw new Error(`Node ${spawned.id} announced the wrong PID`)
    }
    return { ...spawned, pid: ready.pid, url: ready.url }
  } catch (error) {
    spawned.process.kill()
    const stderr = await new Response(spawned.process.stderr).text()
    await spawned.process.exited
    throw new Error(`Node ${spawned.id} failed to start: ${errorMessage(error)}\n${stderr}`)
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(
    () => timeout.reject(new Error("Node readiness timed out")),
    milliseconds,
  )
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) throw new Error("stdout closed before readiness")
      text += decoder.decode(part.value, { stream: true })
      const newline = text.indexOf("\n")
      if (newline >= 0) return text.slice(0, newline)
    }
  } finally {
    reader.releaseLock()
  }
}

async function stopSpawned(nodes: SpawnedNode[]): Promise<void> {
  for (const node of nodes) node.process.kill()
  await Promise.all(nodes.map((node) => node.process.exited))
}

function renderNodePrompt(
  prompt: string,
  node: RunningNode,
  peers: RunningNode[],
  seed: string,
): string {
  const renderedPeers = peers.map((peer) => `- ${peer.id} at ${peer.url}`).join("\n")
  return prompt
    .replaceAll("[id]", node.id)
    .replaceAll("[address]", node.url)
    .replaceAll("[peers]", renderedPeers.length === 0 ? "(none)" : renderedPeers)
    .replaceAll("[seed]", seed.length === 0 ? "(none)" : seed)
}

function findNode(nodes: RunningNode[], id: string): RunningNode {
  const node = nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`Unknown node: ${id}`)
  return node
}

function parseScenario(value: unknown): Scenario {
  const record = requireRecord(value, "scenario")
  const rawNodes = record["nodes"]
  if (!Array.isArray(rawNodes)) throw new Error("scenario.nodes must be an array")
  return {
    entry: requireString(record, "entry"),
    nodes: rawNodes.map((rawNode) => {
      const node = requireRecord(rawNode, "scenario node")
      const rawPeers = node["peers"]
      if (!Array.isArray(rawPeers) || !rawPeers.every((id) => typeof id === "string")) {
        throw new Error("scenario node peers must be an array of IDs")
      }
      return {
        id: requireString(node, "id"),
        peers: rawPeers,
        seed: requireString(node, "seed"),
      }
    }),
  }
}

function validateScenario(scenario: Scenario): void {
  if (scenario.nodes.length === 0) throw new Error("A scenario needs at least one node")
  for (const node of scenario.nodes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(node.id)) {
      throw new Error(`Invalid node ID: ${node.id}`)
    }
    if (scenario.nodes.filter((candidate) => candidate.id === node.id).length !== 1) {
      throw new Error(`Duplicate node ID: ${node.id}`)
    }
    for (const peerId of node.peers) {
      if (!scenario.nodes.some((candidate) => candidate.id === peerId)) {
        throw new Error(`${node.id} references missing peer ${peerId}`)
      }
      if (peerId === node.id) throw new Error(`${node.id} cannot seed itself as a peer`)
    }
  }
  if (!scenario.nodes.some((node) => node.id === scenario.entry)) {
    throw new Error(`Missing entry node: ${scenario.entry}`)
  }
}

function parseManifest(value: unknown): RunManifest {
  const record = requireRecord(value, "network manifest")
  const rawNodes = record["nodes"]
  if (!Array.isArray(rawNodes)) throw new Error("network manifest nodes must be an array")
  return {
    entry: requireString(record, "entry"),
    nodes: rawNodes.map((rawNode) => {
      const node = requireRecord(rawNode, "network manifest node")
      return {
        id: requireString(node, "id"),
        pid: requireNumber(node, "pid"),
        url: requireString(node, "url"),
      }
    }),
  }
}

function parseJson(value: string): unknown {
  return JSON.parse(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
