import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { type TraceEvent } from "./protocol.ts"

type AgentRequest = {
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
  temporaryDirectory: string
  trace: { path: string; relativePath: string } | null
}

type CodexEvents = {
  threadId: string | null
  turnCompleted: boolean
}

let sequence = 0
let threadId: string | null = null
let turnQueue: Promise<void> = Promise.resolve()
const eventLogPathEnvironment = "HUMMINGBIRDS_EVENT_LOG_PATH"
const eventLogPath = Bun.env[eventLogPathEnvironment] ?? "events.jsonl"

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
  const reply = turnQueue.then(() => runQuestion(question, context, startedAt))
  turnQueue = reply.then(
    () => undefined,
    () => undefined,
  )
  return reply
}

async function runQuestion(
  question: string,
  context: AgentRequest,
  startedAt: number,
): Promise<AgentReply> {
  const fail = async (error: string, status: number): Promise<AgentReply> => {
    await record({
      ...eventBase(context),
      durationMs: performance.now() - startedAt,
      error,
      kind: "request_failed",
      status,
    })
    return { body: error, status }
  }
  try {
    const result = await runCodex(question, context)
    if (!result.ok) return fail(result.error, 502)
    await record({
      ...eventBase(context),
      answer: result.answer,
      durationMs: performance.now() - startedAt,
      kind: "request_completed",
      status: 200,
    })
    return { body: result.answer, status: 200 }
  } catch (error) {
    return fail(errorMessage(error), 500)
  }
}

async function runCodex(question: string, context: AgentRequest): Promise<CodexResult> {
  const startedAt = performance.now()
  const capture = await createCodexCapture()
  const resumedThreadId = threadId
  try {
    const command = [
      ...codexCommand(),
      ...codexArguments(capture.answerPath, resumedThreadId),
    ]
    const childEnvironment = { ...process.env }
    delete childEnvironment[eventLogPathEnvironment]
    const child = Bun.spawn({
      cmd: command,
      cwd: process.cwd(),
      env: {
        ...childEnvironment,
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
      codexEvents: capture.trace?.relativePath ?? null,
      kind: "codex_process_started",
      threadId: resumedThreadId,
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    let events: CodexEvents
    try {
      events = parseCodexEvents(stdout)
      if (
        resumedThreadId !== null &&
        events.threadId !== null &&
        events.threadId !== resumedThreadId
      ) {
        throw new Error(`Codex resumed ${events.threadId} instead of ${resumedThreadId}`)
      }
      if (events.threadId !== null) threadId = events.threadId
    } finally {
      if (capture.trace !== null) await writeFile(capture.trace.path, stdout)
    }
    const durationMs = performance.now() - startedAt
    const observedThreadId = events.threadId
    const activeThreadId = observedThreadId ?? resumedThreadId
    const fail = async (
      error: string,
      failedThreadId: string | null,
    ): Promise<CodexResult> => {
      await record({
        ...eventBase(context),
        agentPid: child.pid,
        durationMs,
        error,
        exitCode,
        kind: "codex_process_failed",
        threadId: failedThreadId,
      })
      return { error, ok: false }
    }

    if (exitCode !== 0) {
      const detail = stderr.trim()
      const error = `Codex exited with status ${exitCode}${detail.length === 0 ? "" : `: ${detail}`}`
      return fail(error, activeThreadId)
    }
    if (activeThreadId === null) {
      return fail("Codex returned no thread ID.", null)
    }
    if (!events.turnCompleted) {
      return fail("Codex did not complete its turn.", activeThreadId)
    }

    const answer = (await readFile(capture.answerPath, "utf8")).trimEnd()
    if (answer.length === 0) {
      return fail("Codex returned no answer.", activeThreadId)
    }

    await record({
      ...eventBase(context),
      agentPid: child.pid,
      durationMs,
      kind: "codex_process_completed",
      threadId: activeThreadId,
    })
    return { answer, ok: true }
  } finally {
    await rm(capture.temporaryDirectory, { force: true, recursive: true })
  }
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

function codexArguments(answerPath: string, resumedThreadId: string | null): string[] {
  const commonArguments = [
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    "project_root_markers=[]",
  ]
  const arguments_ = [
    "--search",
    "exec",
  ]
  if (resumedThreadId === null) {
    arguments_.push(
      ...commonArguments,
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "-C",
      process.cwd(),
    )
  } else {
    arguments_.push("resume", ...commonArguments)
  }
  const model = Bun.env["HUMMINGBIRDS_CODEX_MODEL"]
  if (model !== undefined && model.length > 0) arguments_.push("--model", model)
  const effort = Bun.env["HUMMINGBIRDS_CODEX_REASONING_EFFORT"]
  if (effort !== undefined && effort.length > 0) {
    arguments_.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`)
  }
  const summary = Bun.env["HUMMINGBIRDS_CODEX_REASONING_SUMMARY"]
  if (summary !== undefined && summary.length > 0) {
    arguments_.push("-c", `model_reasoning_summary=${JSON.stringify(summary)}`)
  }
  arguments_.push("--json", "--output-last-message", answerPath)
  if (resumedThreadId !== null) arguments_.push(resumedThreadId)
  arguments_.push("-")
  return arguments_
}

async function createCodexCapture(): Promise<CodexCapture> {
  let trace: CodexCapture["trace"] = null
  if (Bun.env["HUMMINGBIRDS_CODEX_JSON_TRACE"] === "1") {
    const directoryName = "codex-traces"
    const directory = resolve(directoryName)
    const captureId = crypto.randomUUID()
    await mkdir(directory, { recursive: true })
    trace = {
      path: join(directory, `${captureId}.jsonl`),
      relativePath: join(directoryName, `${captureId}.jsonl`),
    }
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "hummingbirds-codex-"))
  return {
    answerPath: join(temporaryDirectory, "answer.txt"),
    temporaryDirectory,
    trace,
  }
}

function parseCodexEvents(text: string): CodexEvents {
  let observedThreadId: string | null = null
  let turnCompleted = false
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Codex emitted a non-object JSON event")
    }
    const event = parsed as Record<string, unknown>
    switch (event["type"]) {
      case "thread.started": {
        const value = event["thread_id"]
        if (typeof value !== "string" || value.length === 0) {
          throw new Error("Codex emitted an invalid thread ID")
        }
        if (observedThreadId !== null && observedThreadId !== value) {
          throw new Error("Codex emitted multiple thread IDs")
        }
        observedThreadId = value
        break
      }
      case "turn.completed":
        turnCompleted = true
        break
      default:
        break
    }
  }
  return { threadId: observedThreadId, turnCompleted }
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
  await appendFile(eventLogPath, `${JSON.stringify(event)}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
