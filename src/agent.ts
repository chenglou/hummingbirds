import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { type TraceEvent } from "./protocol.ts"

export type AgentRequest = {
  address: string
  callerId: string
  invocationId: string
  nodeId: string
  parentInvocationId: string | null
  path: string[]
  requestId: string
}

type AgentReply = {
  body: string
  status: number
}

type CodexResult =
  | { answer: string; ok: true }
  | { error: string; ok: false }

type CodexCapture = {
  answerPath: string
  eventsPath: string
  relativeEventsPath: string
  stderrPath: string
}

let sequence = 0

export async function answerQuestion(
  question: string,
  request: AgentRequest,
): Promise<AgentReply> {
  const startedAt = performance.now()
  await record({
    ...eventBase(request),
    callerId: request.callerId,
    kind: "request_received",
    path: request.path,
    question,
  })

  if (request.path.includes(request.nodeId)) {
    await record({
      ...eventBase(request),
      callerId: request.callerId,
      kind: "cycle_rejected",
      path: request.path,
      question,
    })
    return { body: `Cycle rejected at ${request.nodeId}.`, status: 409 }
  }

  const context = { ...request, path: [...request.path, request.nodeId] }
  try {
    const result = await runCodex(question, context)
    if (!result.ok) {
      await record({
        ...eventBase(context),
        durationMs: performance.now() - startedAt,
        error: result.error,
        kind: "request_failed",
        status: 502,
      })
      return { body: result.error, status: 502 }
    }
    await record({
      ...eventBase(context),
      answer: result.answer,
      durationMs: performance.now() - startedAt,
      kind: "request_completed",
      status: 200,
    })
    return { body: result.answer, status: 200 }
  } catch (error) {
    const message = errorMessage(error)
    await record({
      ...eventBase(context),
      durationMs: performance.now() - startedAt,
      error: message,
      kind: "request_failed",
      status: 500,
    })
    return { body: message, status: 500 }
  }
}

async function runCodex(question: string, context: AgentRequest): Promise<CodexResult> {
  const startedAt = performance.now()
  const capture = await createCodexCapture()
  const command = [...codexCommand(), ...codexArguments(capture?.answerPath ?? null)]
  const child = Bun.spawn({
    cmd: command,
    cwd: process.cwd(),
    env: {
      ...process.env,
      HUMMINGBIRDS_CALLER_ID: context.callerId,
      HUMMINGBIRDS_INVOCATION_ID: context.invocationId,
      HUMMINGBIRDS_NODE_ADDRESS: context.address,
      HUMMINGBIRDS_NODE_ID: context.nodeId,
      HUMMINGBIRDS_PARENT_INVOCATION_ID: context.parentInvocationId ?? "",
      HUMMINGBIRDS_PATH: JSON.stringify(context.path),
      HUMMINGBIRDS_REQUEST_ID: context.requestId,
    },
    stdin: new Blob([question]),
    stdout: "pipe",
    stderr: "pipe",
  })

  await record({
    ...eventBase(context),
    agentPid: child.pid,
    codexEvents: capture?.relativeEventsPath ?? null,
    kind: "codex_process_started",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (capture !== null) {
    await Promise.all([
      writeFile(capture.eventsPath, stdout),
      writeFile(capture.stderrPath, stderr),
    ])
  }
  const durationMs = performance.now() - startedAt
  if (exitCode !== 0) {
    const detail = stderr.trim()
    const error = `Codex exited with status ${exitCode}${detail.length === 0 ? "" : `: ${detail}`}`
    await record({
      ...eventBase(context),
      agentPid: child.pid,
      durationMs,
      error,
      exitCode,
      kind: "codex_process_failed",
    })
    return { error, ok: false }
  }

  const answer = (capture === null ? stdout : await readFile(capture.answerPath, "utf8")).trimEnd()
  if (answer.length === 0) {
    const error = "Codex returned no answer."
    await record({
      ...eventBase(context),
      agentPid: child.pid,
      durationMs,
      error,
      exitCode,
      kind: "codex_process_failed",
    })
    return { error, ok: false }
  }

  await record({
    ...eventBase(context),
    agentPid: child.pid,
    durationMs,
    kind: "codex_process_completed",
  })
  return { answer, ok: true }
}

function codexCommand(): string[] {
  const value = Bun.env["HUMMINGBIRDS_CODEX_COMMAND"]
  if (value === undefined) return ["codex"]

  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("HUMMINGBIRDS_CODEX_COMMAND must be a JSON array of command parts")
  }
  const command: string[] = []
  for (const part of parsed) {
    if (typeof part !== "string" || part.length === 0) {
      throw new Error("HUMMINGBIRDS_CODEX_COMMAND must be a JSON array of command parts")
    }
    command.push(part)
  }
  return command
}

function codexArguments(lastMessagePath: string | null): string[] {
  const arguments_ = [
    "--search",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "-C",
    process.cwd(),
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    "project_root_markers=[]",
  ]
  const model = Bun.env["HUMMINGBIRDS_CODEX_MODEL"]
  if (model !== undefined && model.length > 0) arguments_.push("--model", model)
  const effort = Bun.env["HUMMINGBIRDS_CODEX_REASONING_EFFORT"]
  if (effort !== undefined && effort.length > 0) {
    arguments_.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`)
  }
  if (lastMessagePath !== null) {
    arguments_.push("--json", "--output-last-message", lastMessagePath)
  }
  arguments_.push("-")
  return arguments_
}

async function createCodexCapture(): Promise<CodexCapture | null> {
  if (Bun.env["HUMMINGBIRDS_CODEX_JSON_TRACE"] !== "1") return null

  const directoryName = "codex-traces"
  const directory = resolve(directoryName)
  const captureId = crypto.randomUUID()
  await mkdir(directory, { recursive: true })
  return {
    answerPath: join(directory, `${captureId}.answer.txt`),
    eventsPath: join(directory, `${captureId}.jsonl`),
    relativeEventsPath: join(directoryName, `${captureId}.jsonl`),
    stderrPath: join(directory, `${captureId}.stderr.log`),
  }
}

function eventBase(context: AgentRequest) {
  return {
    at: performance.timeOrigin + performance.now(),
    invocationId: context.invocationId,
    nodeId: context.nodeId,
    parentInvocationId: context.parentInvocationId,
    pid: process.pid,
    requestId: context.requestId,
    seq: (sequence += 1),
  }
}

async function record(event: TraceEvent): Promise<void> {
  await appendFile("events.jsonl", `${JSON.stringify(event)}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
