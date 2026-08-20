import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import {
  headers,
  requireRecord,
  requireString,
  type TraceEvent,
} from "./protocol.ts"
import { parseReadyMessage, parseTraceEvent } from "./trace.ts"

type Scenario = {
  entry: string
  nodes: { id: string; peers: string[]; seed: string }[]
}

type NodeRuntime = {
  directory: string
  id: string
  root: string
}

type SpawnedNode = NodeRuntime & {
  process: Bun.Subprocess<"ignore", "pipe", "pipe">
}

type RunningNode = SpawnedNode & {
  url: string
}

export type RunningNetwork = {
  entry: string
  nodes: RunningNode[]
  runDirectory: string
}

type AskResult = {
  answer: string
  requestId: string
  status: number
}

const sourceDirectory = import.meta.dir
const eventLogPathEnvironment = "HUMMINGBIRDS_EVENT_LOG_PATH"
const threadIdPathEnvironment = "HUMMINGBIRDS_THREAD_ID_PATH"

async function loadScenario(path: string): Promise<Scenario> {
  const scenario = parseScenario(JSON.parse(await readFile(path, "utf8")))
  validateScenario(scenario)
  return scenario
}

export async function startNetwork(
  scenarioPath: string,
  runDirectory: string,
  environment: Record<string, string> = {},
): Promise<RunningNetwork> {
  const absoluteRunDirectory = resolve(runDirectory)
  const scenario = await loadScenario(resolve(scenarioPath))
  const prompt = await readFile(join(sourceDirectory, "prompt.md"), "utf8")

  await mkdir(dirname(absoluteRunDirectory), { recursive: true })
  await mkdir(absoluteRunDirectory)

  const runtimes: NodeRuntime[] = []
  try {
    for (const seed of scenario.nodes) {
      const root = await mkdtemp(join(tmpdir(), "hummingbirds-node-"))
      runtimes.push({ directory: join(root, "workspace"), id: seed.id, root })
    }
    await Promise.all(
      runtimes.map(async (runtime) => {
        const archiveDirectory = join(absoluteRunDirectory, runtime.id)
        await Promise.all([mkdir(runtime.directory), mkdir(archiveDirectory)])
        await Promise.all([
          copyFile(join(sourceDirectory, "agent.ts"), join(runtime.directory, "agent.ts")),
          copyFile(join(sourceDirectory, "protocol.ts"), join(runtime.directory, "protocol.ts")),
          copyFile(join(sourceDirectory, "server.ts"), join(runtime.directory, "server.ts")),
          writeFile(join(archiveDirectory, "events.jsonl"), ""),
        ])
      }),
    )
  } catch (error) {
    await removeRuntimeRoots(runtimes.map((runtime) => runtime.root))
    throw error
  }

  const spawned = runtimes.map((runtime) =>
    spawnNode(
      runtime,
      join(absoluteRunDirectory, runtime.id, "events.jsonl"),
      environment,
    ),
  )

  let nodes: RunningNode[]
  try {
    nodes = await Promise.all(spawned.map(readReady))
  } catch (error) {
    await stopSpawned(spawned)
    throw error
  }

  const network = { entry: scenario.entry, nodes, runDirectory: absoluteRunDirectory }
  try {
    await Promise.all(
      scenario.nodes.map(async (seed) => {
        const peers = seed.peers.map((peerId) => findNode(nodes, peerId))
        const node = findNode(nodes, seed.id)
        await writeFile(
          join(node.directory, "AGENTS.md"),
          renderNodePrompt(prompt, node, peers, seed.seed),
        )
      }),
    )

    const manifest = {
      entry: scenario.entry,
      nodes: nodes.map(({ id, process, url }) => ({ id, pid: process.pid, url })),
    }
    await writeFile(join(absoluteRunDirectory, "network.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    return network
  } catch (error) {
    await stopNetwork(network)
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
    requestId: responseRequestId,
    status: response.status,
  }
}

export async function stopNetwork(network: RunningNetwork): Promise<void> {
  for (const node of network.nodes) node.process.kill()
  await Promise.all(network.nodes.map((node) => node.process.exited))
  await Promise.all(
    network.nodes.map((node) => {
      const reservedFiles = new Set([
        join(node.directory, "events.jsonl"),
        join(node.directory, "thread-id"),
      ])
      return cp(node.directory, join(network.runDirectory, node.id), {
        filter: (source) => !reservedFiles.has(resolve(source)),
        recursive: true,
      })
    }),
  )
  await removeRuntimeRoots(network.nodes.map((node) => node.root))
}

export async function readTrace(
  runDirectory: string,
  requestId: string | null = null,
): Promise<TraceEvent[]> {
  const absoluteRunDirectory = resolve(runDirectory)
  const nodeIds = parseManifestNodeIds(
    JSON.parse(await readFile(join(absoluteRunDirectory, "network.json"), "utf8")),
  )
  const eventGroups = await Promise.all(
    nodeIds.map(async (nodeId) => {
      const text = await readFile(join(absoluteRunDirectory, nodeId, "events.jsonl"), "utf8")
      const events: TraceEvent[] = []
      for (const line of text.split("\n")) {
        if (line.length === 0) continue
        const event = parseTraceEvent(JSON.parse(line))
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
  runtime: NodeRuntime,
  eventLogPath: string,
  environment: Record<string, string>,
): SpawnedNode {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "server.ts"],
    cwd: runtime.directory,
    env: {
      ...process.env,
      ...environment,
      [eventLogPathEnvironment]: eventLogPath,
      [threadIdPathEnvironment]: join(dirname(eventLogPath), "thread-id"),
      HUMMINGBIRDS_NODE_ID: runtime.id,
      HUMMINGBIRDS_PORT: "0",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  return { ...runtime, process: child }
}

async function readReady(spawned: SpawnedNode): Promise<RunningNode> {
  try {
    const line = await withTimeout(readFirstLine(spawned.process.stdout), 10_000)
    const ready = parseReadyMessage(JSON.parse(line))
    if (ready.id !== spawned.id) {
      throw new Error(`Node ${spawned.id} announced itself as ${ready.id}`)
    }
    if (ready.pid !== spawned.process.pid) {
      throw new Error(`Node ${spawned.id} announced the wrong PID`)
    }
    return { ...spawned, url: ready.url }
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
  await removeRuntimeRoots(nodes.map((node) => node.root))
}

async function removeRuntimeRoots(roots: string[]): Promise<void> {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })))
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

function parseManifestNodeIds(value: unknown): string[] {
  const record = requireRecord(value, "network manifest")
  const rawNodes = record["nodes"]
  if (!Array.isArray(rawNodes)) throw new Error("network manifest nodes must be an array")
  return rawNodes.map((rawNode) =>
    requireString(requireRecord(rawNode, "network manifest node"), "id"),
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
