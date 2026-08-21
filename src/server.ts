// One bird: an HTTP server that forwards each question to a persistent Codex
// conversation. Run it inside the bird's directory, which holds:
//   thread-id     the Codex conversation to resume (created on the first question)
//   events.jsonl  a log of every request, for inspection only
//   workspace/    Codex's working directory, where AGENTS.md tells the bird who it is
import { appendFileSync, mkdirSync } from "fs"
import { basename, join } from "path"

const headers = {
  callerId: "x-hummingbirds-caller-id",
  invocationId: "x-hummingbirds-invocation-id",
  parentInvocationId: "x-hummingbirds-parent-invocation-id",
  path: "x-hummingbirds-path",
  requestId: "x-hummingbirds-request-id",
} as const

type Context = {
  callerId: string
  invocationId: string
  parentInvocationId: string | null
  path: string[]
  requestId: string
}

export type Event = Context & {
  at: number
  kind: "received" | "rejected" | "started" | "completed" | "failed"
  nodeId: string
  seq: number
  question?: string
  threadId?: string | null
  codexPid?: number
  status?: number
  answer?: string
  error?: string
}

type CodexEvent = {
  type?: string
  thread_id?: string
  item?: { type?: string; text?: string }
}

const nodeId = basename(process.cwd())
const codex = Bun.env["HUMMINGBIRDS_CODEX"] ?? "codex"
// Top-level `codex` flags (for example `-m model` or `-c key=value`); they apply to
// fresh and resumed turns alike.
const codexArgs = (Bun.env["HUMMINGBIRDS_CODEX_ARGS"] ?? "")
  .split(/\s+/)
  .filter((arg) => arg !== "")
const workspace = join(process.cwd(), "workspace")
const threadIdPath = join(process.cwd(), "thread-id")
const eventsPath = join(process.cwd(), "events.jsonl")
let queue: Promise<unknown> = Promise.resolve()
let seq = 0

mkdirSync(workspace, { recursive: true })

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(Bun.env["HUMMINGBIRDS_PORT"] ?? 0),
  fetch: handleRequest,
})
const address = `http://127.0.0.1:${server.port}/ask`
console.log(JSON.stringify({ id: nodeId, pid: process.pid, url: address }))

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/ask") {
    return new Response("POST a plain-text question to /ask", { status: 404 })
  }
  const path = parsePath(request.headers.get(headers.path))
  const context: Context = {
    callerId: request.headers.get(headers.callerId) ?? "human",
    invocationId: request.headers.get(headers.invocationId) ?? crypto.randomUUID(),
    parentInvocationId: request.headers.get(headers.parentInvocationId),
    path: path ?? [],
    requestId: request.headers.get(headers.requestId) ?? crypto.randomUUID(),
  }
  if (path === null) return reply(400, `${headers.path} must be a JSON array of node IDs`, context)
  const question = await request.text()
  record(context, "received", { question })

  if (context.path.includes(nodeId)) {
    record(context, "rejected")
    return reply(409, `Cycle rejected at ${nodeId}.`, context)
  }

  // One Codex turn at a time: the conversation is a single thread.
  const turn = queue.then(() => ask(question, context))
  queue = turn.catch(() => {})
  try {
    const { answer, threadId } = await turn
    record(context, "completed", { answer, status: 200, threadId })
    return reply(200, answer, context)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record(context, "failed", { error: message, status: 500 })
    return reply(500, message, context)
  }
}

async function ask(
  question: string,
  context: Context,
): Promise<{ answer: string; threadId: string }> {
  const threadIdFile = Bun.file(threadIdPath)
  const savedThreadId = (await threadIdFile.exists()) ? (await threadIdFile.text()).trim() : ""
  const threadId = savedThreadId === "" ? null : savedThreadId
  const common = [
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
    "--json",
  ]
  const args =
    threadId === null
      ? [...codexArgs, "--search", "exec", ...common, "-"]
      : [...codexArgs, "--search", "exec", "resume", ...common, threadId, "-"]
  const child = Bun.spawn([codex, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      HUMMINGBIRDS_CALLER_ID: context.callerId,
      HUMMINGBIRDS_INVOCATION_ID: context.invocationId,
      HUMMINGBIRDS_NODE_ADDRESS: address,
      HUMMINGBIRDS_NODE_ID: nodeId,
      HUMMINGBIRDS_PARENT_INVOCATION_ID: context.parentInvocationId ?? "",
      HUMMINGBIRDS_PATH: JSON.stringify([...context.path, nodeId]),
      HUMMINGBIRDS_REQUEST_ID: context.requestId,
    },
    stdin: new Blob([question]),
    stdout: "pipe",
    stderr: "pipe",
  })
  record(context, "started", { codexPid: child.pid, threadId })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  let startedThreadId: string | null = null
  let answer: string | null = null
  for (const line of stdout.split("\n")) {
    const event = parseEvent(line)
    if (event === null) continue
    if (event.type === "thread.started") startedThreadId = event.thread_id ?? null
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      answer = event.item.text ?? null
    }
  }
  if (threadId === null && startedThreadId !== null) await Bun.write(threadIdPath, startedThreadId)

  if (exitCode !== 0)
    throw new Error(`Codex exited with ${exitCode}: ${stderr.trim().slice(-2000)}`)
  if (startedThreadId === null) throw new Error("Codex did not report a thread ID")
  if (threadId !== null && startedThreadId !== threadId) {
    throw new Error(`Codex resumed thread ${startedThreadId} instead of ${threadId}`)
  }
  if (answer === null || answer === "") throw new Error("Codex produced no answer")
  return { answer, threadId: startedThreadId }
}

function record(context: Context, kind: Event["kind"], extra: Partial<Event> = {}): void {
  const event: Event = { ...context, ...extra, at: Date.now(), kind, nodeId, seq: seq++ }
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
}

function reply(status: number, body: string, context: Context): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      [headers.invocationId]: context.invocationId,
      [headers.requestId]: context.requestId,
    },
  })
}

function parsePath(raw: string | null): string[] | null {
  if (raw === null) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return null
    const ids: unknown[] = value
    return ids.every((id): id is string => typeof id === "string") ? ids : null
  } catch {
    return null
  }
}

function parseEvent(line: string): CodexEvent | null {
  if (!line.startsWith("{")) return null
  try {
    return JSON.parse(line) as CodexEvent
  } catch {
    return null
  }
}
