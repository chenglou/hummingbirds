import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"

import {
  askNetwork,
  readTrace,
  startNetwork,
  stopNetwork,
  type RunningNetwork,
} from "./local-flock/harness.ts"

export type SlowPeerObservation = {
  answerMatched: boolean
  attributionMatched: boolean
  danglingCommandIds: string[]
  peerAbortedCount: number
  peerReceiptCount: number
  peerReleaseCount: number
  processFailureCount: number
  status: number
  turnCompleted: boolean
}

export type SlowPeerScore = {
  passed: boolean
  reasons: string[]
}

type Config = {
  codex: string
  delayMs: number
  promptPath: string
  trials: number
}

type CommandTrace = {
  danglingCommandIds: string[]
  turnCompleted: boolean
}

type PeerState = {
  aborted: number
  active: number
  receipts: number
  releases: number
}

const model = "gpt-5.6-luna"
const reasoningEffort = "low"

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export function scoreSlowPeerTrial(observation: SlowPeerObservation): SlowPeerScore {
  const reasons: string[] = []
  if (observation.status !== 200) reasons.push(`root returned HTTP ${observation.status}`)
  if (!observation.answerMatched) reasons.push("root answer omitted the peer's random answer")
  if (!observation.attributionMatched) reasons.push("root answer omitted the peer address")
  if (observation.peerReceiptCount !== 1) {
    reasons.push(`peer received ${observation.peerReceiptCount} requests instead of one`)
  }
  if (observation.peerReleaseCount !== 1) {
    reasons.push(`peer released ${observation.peerReleaseCount} responses instead of one`)
  }
  if (observation.peerAbortedCount !== 0) {
    reasons.push(`${observation.peerAbortedCount} peer request(s) were aborted`)
  }
  if (observation.danglingCommandIds.length > 0) {
    reasons.push(`unfinished commands: ${observation.danglingCommandIds.join(", ")}`)
  }
  if (observation.processFailureCount !== 0) {
    reasons.push(`${observation.processFailureCount} Codex process failure(s)`)
  }
  if (!observation.turnCompleted) reasons.push("Codex turn did not complete")
  return { passed: reasons.length === 0, reasons }
}

async function main(arguments_: string[]): Promise<void> {
  const config = parseArguments(arguments_)
  if (config === null) return
  const prompt = await readFile(config.promptPath, "utf8")
  const promptSha256 = await sha256(prompt)
  const codexVersion = await readCodexVersion(config.codex)

  console.log(
    JSON.stringify({
      codex: config.codex,
      codexVersion,
      delayMs: config.delayMs,
      kind: "slow_peer_eval_started",
      model,
      promptPath: config.promptPath,
      promptSha256,
      reasoningEffort,
      trials: config.trials,
    }),
  )

  const results = []
  for (let trial = 1; trial <= config.trials; trial += 1) {
    const result = await runTrial(config, prompt, trial)
    results.push(result)
    console.log(JSON.stringify({ kind: "slow_peer_trial_completed", ...result }))
  }

  const passed = results.every((result) => result.score.passed)
  console.log(
    JSON.stringify({
      failedTrials: results.filter((result) => !result.score.passed).map((result) => result.trial),
      kind: "slow_peer_eval_completed",
      passed,
      trials: config.trials,
    }),
  )
  if (!passed) process.exitCode = 1
}

async function runTrial(config: Config, prompt: string, trial: number) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "hummingbirds-slow-peer-"))
  const scenarioDirectory = join(rootDirectory, "scenario")
  const suffix = `${new Date().toISOString().replaceAll(":", "-")}-${trial}-${crypto.randomUUID().slice(0, 8)}`
  const runDirectory = resolve("logs", "slow-peer", suffix)
  const questionKey = crypto.randomUUID()
  const randomAnswer = `signal-${crypto.randomUUID()}`
  const question = `What exact signal is held by slow peer test ${questionKey}?`
  const peerState: PeerState = { aborted: 0, active: 0, receipts: 0, releases: 0 }
  let peerUrl = ""
  let network: RunningNetwork | null = null
  const startedAt = performance.now()

  const peer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/ask") {
        return new Response("POST /ask", { status: 404 })
      }
      const body = await request.text()
      peerState.receipts += 1
      peerState.active += 1
      let aborted = false
      const markAborted = () => {
        if (aborted) return
        aborted = true
        peerState.aborted += 1
      }
      request.signal.addEventListener("abort", markAborted)
      try {
        if (!body.includes(questionKey)) return new Response("Question key missing", { status: 400 })
        await Bun.sleep(config.delayMs)
        peerState.releases += 1
        return new Response(
          `${randomAnswer}\n\nContributor: slow-peer at ${peerUrl}`,
          { headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      } finally {
        request.signal.removeEventListener("abort", markAborted)
        peerState.active -= 1
      }
    },
  })
  peerUrl = `http://127.0.0.1:${peer.port}/ask`

  try {
    await mkdir(scenarioDirectory, { recursive: true })
    await writeFile(
      join(scenarioDirectory, "scenario.json"),
      `${JSON.stringify(
        { entry: "a", nodes: [{ id: "a", peers: [], seed: "" }] },
        null,
        2,
      )}\n`,
    )

    network = await startNetwork(join(scenarioDirectory, "scenario.json"), runDirectory, {
      HUMMINGBIRDS_CODEX_COMMAND: JSON.stringify([config.codex]),
      HUMMINGBIRDS_CODEX_JSON_TRACE: "1",
      HUMMINGBIRDS_CODEX_MODEL: model,
      HUMMINGBIRDS_CODEX_REASONING_EFFORT: reasoningEffort,
    })
    const node = requireNode(network, "a")
    await writeFile(
      join(node.directory, "AGENTS.md"),
      prompt
        .replaceAll("[id]", node.id)
        .replaceAll("[address]", node.url)
        .replaceAll("[peers]", `- slow-peer at ${peerUrl}`)
        .replaceAll("[seed]", "(none)"),
    )

    const answer = await withTimeout(
      askNetwork(network, question, `slow-peer-${questionKey}`),
      config.delayMs + 180_000,
      "Root request timed out",
    )
    await withTimeout(
      waitUntil(() => peerState.active === 0),
      config.delayMs + 60_000,
      "Peer requests did not settle",
    )

    const trace = await readTrace(runDirectory)
    const start = trace.find(
      (event) => event.kind === "codex_process_started" && event.nodeId === "a",
    )
    if (start?.kind !== "codex_process_started" || start.codexEvents === null) {
      throw new Error("Missing root Codex JSON trace")
    }
    const commandTrace = inspectCommandTrace(
      await readFile(join(runDirectory, node.id, start.codexEvents), "utf8"),
    )
    const observation: SlowPeerObservation = {
      answerMatched: answer.answer.includes(randomAnswer),
      attributionMatched: answer.answer.includes(peerUrl),
      danglingCommandIds: commandTrace.danglingCommandIds,
      peerAbortedCount: peerState.aborted,
      peerReceiptCount: peerState.receipts,
      peerReleaseCount: peerState.releases,
      processFailureCount: trace.filter((event) => event.kind === "codex_process_failed").length,
      status: answer.status,
      turnCompleted: commandTrace.turnCompleted,
    }
    return {
      durationMs: performance.now() - startedAt,
      observation,
      runDirectory,
      score: scoreSlowPeerTrial(observation),
      trial,
    }
  } finally {
    try {
      if (network !== null) await stopNetwork(network)
    } finally {
      try {
        await peer.stop(true)
      } finally {
        await rm(rootDirectory, { force: true, recursive: true })
      }
    }
  }
}

function inspectCommandTrace(text: string): CommandTrace {
  const running = new Set<string>()
  let turnCompleted = false
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    const event: unknown = JSON.parse(line)
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue
    const record = event as Record<string, unknown>
    if (record["type"] === "turn.completed") turnCompleted = true
    const item = record["item"]
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue
    const itemRecord = item as Record<string, unknown>
    if (itemRecord["type"] !== "command_execution") continue
    const id = itemRecord["id"]
    if (typeof id !== "string") continue
    switch (record["type"]) {
      case "item.started":
        running.add(id)
        break
      case "item.completed":
        running.delete(id)
        break
      default:
        break
    }
  }
  return { danglingCommandIds: [...running], turnCompleted }
}

function parseArguments(arguments_: string[]): Config | null {
  if (arguments_.includes("--help")) {
    console.log(usage())
    return null
  }
  let allowed = false
  let codex: string | null = null
  let delayMs = 45_000
  let promptPath = resolve("src/prompt_template.md")
  let trials = 4

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    switch (argument) {
      case "--run-real-model":
        allowed = true
        break
      case "--codex":
        codex = resolve(requireNext(arguments_, ++index, argument))
        break
      case "--delay-ms":
        delayMs = parsePositiveInteger(requireNext(arguments_, ++index, argument), argument)
        break
      case "--prompt":
        promptPath = resolve(requireNext(arguments_, ++index, argument))
        break
      case "--trials":
        trials = parsePositiveInteger(requireNext(arguments_, ++index, argument), argument)
        break
      default:
        throw new Error(`Unknown argument: ${argument ?? ""}\n${usage()}`)
    }
  }
  if (!allowed) throw new Error(`Pass --run-real-model to acknowledge live model calls.\n${usage()}`)
  if (codex === null) throw new Error(`Pass the app-bundled CLI with --codex.\n${usage()}`)
  if (delayMs <= 30_000) throw new Error("--delay-ms must exceed Codex's 30-second tool yield")
  return { codex, delayMs, promptPath, trials }
}

function usage(): string {
  return [
    "Usage:",
    "  bun run experiment:slow-peer --run-real-model --codex <path> [--prompt <path>] [--trials 4] [--delay-ms 45000]",
  ].join("\n")
}

function requireNext(arguments_: string[], index: number, option: string): string {
  const value = arguments_[index]
  if (value === undefined) throw new Error(`${option} requires a value`)
  return value
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer`)
  return parsed
}

async function readCodexVersion(codex: string): Promise<string> {
  const child = Bun.spawn([codex, "--version"], { stderr: "pipe", stdout: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Codex version check failed: ${stderr.trim()}`)
  return stdout.trim()
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await Bun.sleep(100)
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(message)), milliseconds)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

function requireNode(network: RunningNetwork, id: string): RunningNetwork["nodes"][number] {
  const node = network.nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`Missing node ${id}`)
  return node
}
