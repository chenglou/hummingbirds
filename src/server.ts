// One bird: an HTTP server that forwards each question to a persistent Codex
// conversation. Run it inside the bird's directory, which holds:
//   thread-id     the Codex conversation to resume (created on the first question)
//   events.jsonl  a log of every request, for inspection only
//   workspace/    Codex's working directory, where AGENTS.md tells the bird who it is
import { appendFileSync, mkdirSync } from "fs"
import { rename } from "fs/promises"
import { basename, join } from "path"

const headers = {
  callerId: "x-hummingbirds-caller-id",
  inReplyTo: "x-hummingbirds-in-reply-to",
  invocationId: "x-hummingbirds-invocation-id",
  parentInvocationId: "x-hummingbirds-parent-invocation-id",
  path: "x-hummingbirds-path",
  replyTo: "x-hummingbirds-reply-to",
  requestId: "x-hummingbirds-request-id",
} as const

type Context = {
  callerId: string
  inReplyTo: string | null
  invocationId: string
  parentInvocationId: string | null
  path: string[]
  replyTo: string | null
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
// Extra flags for the Codex turn, for example `-m model` or `-c key=value`, split on
// whitespace (no shell quoting: a literal space always splits). They go after the
// subcommand because `codex` silently drops root-level `-c` overrides, so they must be
// valid for both `codex exec` and `codex exec resume` (`-s`, `-C` and the other
// exec-only flags are not).
const codexArgs = (Bun.env["HUMMINGBIRDS_CODEX_ARGS"] ?? "")
  .split(/\s+/)
  .filter((arg) => arg !== "")
const workspace = join(process.cwd(), "workspace")
const threadIdPath = join(process.cwd(), "thread-id")
const eventsPath = join(process.cwd(), "events.jsonl")
let queue: Promise<unknown> = Promise.resolve()
// Requests with a question turn running or queued here.
const inProgress = new Set<string>()
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
  const inReplyTo = request.headers.get(headers.inReplyTo)
  const context: Context = {
    callerId: request.headers.get(headers.callerId) ?? "human",
    inReplyTo,
    invocationId: request.headers.get(headers.invocationId) ?? crypto.randomUUID(),
    parentInvocationId: request.headers.get(headers.parentInvocationId),
    path: path ?? [],
    replyTo: request.headers.get(headers.replyTo),
    requestId: request.headers.get(headers.requestId) ?? inReplyTo ?? crypto.randomUUID(),
  }
  if (path === null) return reply(400, `${headers.path} must be a JSON array of node IDs`, context)
  const question = await request.text()
  record(context, "received", { question })

  // Usually a reply whose body never made it into curl; better to hear about it now.
  if (question.trim() === "") {
    record(context, "rejected", { error: "Empty message" })
    return reply(400, "Empty message.", context)
  }

  // A question that already went through this bird is a cycle. A reply is not a
  // question, so whatever path it carries is fine.
  if (inReplyTo === null && context.path.includes(nodeId)) {
    record(context, "rejected")
    return reply(409, `Cycle rejected at ${nodeId}.`, context)
  }
  // So is a question for a request this bird is already working on through another
  // branch: queueing it could leave two branches waiting on each other's turn forever.
  if (inReplyTo === null && inProgress.has(context.requestId)) {
    record(context, "rejected")
    return reply(409, `Already on ${context.requestId} at ${nodeId}.`, context)
  }

  // Someone is waiting on the line only for a plain question. A reply, or a question
  // that asks to be answered at a Reply-to address, gets a 202 right away and its turn
  // runs on its own; the bird POSTs whatever it has to say.
  const waiting = context.replyTo === null && inReplyTo === null
  const turn = runTurn(question, context, waiting)
  if (waiting) return turn
  void turn
  return reply(202, `Accepted by ${nodeId}.`, context)
}

async function runTurn(question: string, context: Context, waiting: boolean): Promise<Response> {
  // One Codex turn at a time: the conversation is a single thread.
  const turn = queue.then(() => ask(question, context))
  queue = turn.catch(() => {})
  if (context.inReplyTo === null) {
    inProgress.add(context.requestId)
    void turn.catch(() => {}).finally(() => inProgress.delete(context.requestId))
  }
  try {
    const { answer, threadId } = await turn
    if (waiting && answer === "") throw new Error("Codex produced no answer")
    record(context, "completed", { answer, status: 200, threadId })
    return reply(200, answer, context)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record(context, "failed", { error: message, status: 500 })
    if (context.replyTo !== null) await reportFailure(message, context)
    return reply(500, message, context)
  }
}

// Nobody is on the line to see the 500, so tell the Reply-to address, the same way
// the bird itself would have. Best effort: the failure is already on record.
async function reportFailure(message: string, context: Context): Promise<void> {
  await fetch(context.replyTo ?? "", {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      [headers.callerId]: nodeId,
      [headers.inReplyTo]: context.requestId,
      [headers.invocationId]: crypto.randomUUID(),
      [headers.parentInvocationId]: context.invocationId,
      [headers.path]: JSON.stringify(outgoingPath(context)),
      [headers.requestId]: context.requestId,
    },
    body: message,
  }).catch(() => {})
}

async function ask(
  question: string,
  context: Context,
): Promise<{ answer: string; threadId: string }> {
  const threadIdFile = Bun.file(threadIdPath)
  const threadId = (await threadIdFile.exists()) ? (await threadIdFile.text()).trim() : null
  // The conversation is the bird's only memory, so never quietly start a new one.
  if (threadId === "") throw new Error(`${threadIdPath} is empty`)
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
      ? ["--search", "exec", ...common, ...codexArgs, "-"]
      : ["--search", "exec", "resume", ...common, ...codexArgs, threadId, "-"]
  const child = Bun.spawn([codex, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      HUMMINGBIRDS_CALLER_ID: context.callerId,
      HUMMINGBIRDS_INVOCATION_ID: context.invocationId,
      HUMMINGBIRDS_NODE_ADDRESS: address,
      HUMMINGBIRDS_NODE_ID: nodeId,
      HUMMINGBIRDS_PARENT_INVOCATION_ID: context.parentInvocationId ?? "",
      HUMMINGBIRDS_PATH: JSON.stringify(outgoingPath(context)),
      HUMMINGBIRDS_REQUEST_ID: context.requestId,
    },
    stdin: new Blob([envelope(question, context)]),
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
  if (threadId === null && startedThreadId !== null) {
    await Bun.write(`${threadIdPath}.tmp`, startedThreadId)
    await rename(`${threadIdPath}.tmp`, threadIdPath)
  }

  if (exitCode !== 0)
    throw new Error(`Codex exited with ${exitCode}: ${stderr.trim().slice(-2000)}`)
  if (startedThreadId === null) throw new Error("Codex did not report a thread ID")
  if (threadId !== null && startedThreadId !== threadId) {
    throw new Error(`Codex resumed thread ${startedThreadId} instead of ${threadId}`)
  }
  // An empty final message is fine when the bird already POSTed its reply.
  return { answer: answer ?? "", threadId: startedThreadId }
}

// The path this bird's own calls carry. A reply comes back with the path the question
// took from here, so pick up where this bird left off instead of appending the return
// leg: a follow-up to a contributor is not a cycle.
function outgoingPath(context: Context): string[] {
  const self = context.inReplyTo === null ? -1 : context.path.indexOf(nodeId)
  return [...(self < 0 ? context.path : context.path.slice(0, self)), nodeId]
}

// What Codex reads: who sent the message, which request it belongs to, where the
// answer should go, then the message itself.
function envelope(question: string, context: Context): string {
  const lines = [
    `From: ${context.callerId}`,
    context.inReplyTo === null ? `Request: ${context.requestId}` : `Re: ${context.inReplyTo}`,
  ]
  if (context.replyTo !== null) lines.push(`Reply-to: ${context.replyTo}`)
  return `${lines.join("\n")}\n\n${question}`
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
