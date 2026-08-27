// One bird: an HTTP server that hands each message to a persistent Codex
// conversation. Each independently managed bird directory holds:
//   bird.json     its durable identity and listening port
//   run.json      the current process's private lifecycle-control token
//   thread-id     the Codex conversation to resume (created on the first message)
//   events.jsonl  a log of every message, for inspection only
//   workspace/    Codex's working directory, where AGENTS.md tells the bird who it is
// Nobody waits on the line: a message is acknowledged at once, the turn runs in its
// own time, and the bird POSTs whatever it has to say to the message's x-reply-to address.
import { appendFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { rename } from "fs/promises"
import { dirname, join, resolve } from "path"
import { birdDirectory, codexCommand, createBird, readBird, startBird } from "./local"

const headers = {
  callerId: "x-from",
  inReplyTo: "x-in-reply-to",
  replyTo: "x-reply-to",
  requestId: "x-request",
  route: "x-route",
} as const

type Context = {
  callerId: string
  inReplyTo: string | null
  invocationId: string
  path: string[]
  replyTo: string | null
  requestId: string
}

type Event =
  | { kind: "received"; question: string }
  | { kind: "rejected" | "failed"; error: string }
  | { kind: "started"; codexPid: number; threadId: string | null }
  | { kind: "completed"; threadId: string }

const directory = resolve(Bun.env["HUMMINGBIRDS_DIRECTORY"] ?? "bird")
const bird = readBird(directory)
const nodeId = bird.id
const hatchMaxBirds = Number(Bun.env["HUMMINGBIRDS_HATCH_MAX_BIRDS"] ?? 32)
if (!Number.isSafeInteger(hatchMaxBirds) || hatchMaxBirds < 1) {
  throw new Error("HUMMINGBIRDS_HATCH_MAX_BIRDS must be a positive integer")
}
// Extra flags for the Codex turn, for example `-m model` or `-c key=value`, split on
// whitespace (no shell quoting: a literal space always splits). They go after the
// subcommand because `codex` silently drops root-level `-c` overrides, so they must be
// valid for both `codex exec` and `codex exec resume` (`-s`, `-C` and the other
// exec-only flags are not).
const codexArgs = (Bun.env["HUMMINGBIRDS_CODEX_ARGS"] ?? "")
  .split(/\s+/)
  .filter((arg) => arg !== "")
const workspace = join(directory, "workspace")
const threadIdPath = join(directory, "thread-id")
const eventsPath = join(directory, "events.jsonl")
const subscribers: ReadableStreamDefaultController<Uint8Array>[] = []
const encoder = new TextEncoder()
const failureAbort = new AbortController()
let queue: Promise<unknown> = Promise.resolve()
let hatches: Promise<unknown> = Promise.resolve()
let stopping = false
let forced = false
let active: { pid: number } | null = null
const token = crypto.randomUUID()
const runPath = join(directory, "run.json")

const server = Bun.serve({
  hostname: "127.0.0.1",
  idleTimeout: 0,
  port: bird.port,
  fetch: (request) => {
    switch (new URL(request.url).pathname) {
      case "/control":
        return control(request)
      case "/events":
        return request.method === "GET"
          ? streamEvents()
          : new Response("GET /events", { status: 405 })
      case "/hatch":
        return hatch(request)
      default:
        return handleRequest(request)
    }
  },
})
const address = `http://127.0.0.1:${server.port}/ask`
writeFileSync(`${runPath}.tmp`, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 })
renameSync(`${runPath}.tmp`, runPath)
const startup = `${JSON.stringify({ id: nodeId, pid: process.pid, url: address })}\n`
emit(startup)

process.on("SIGINT", () => shutdown(false))
process.on("SIGTERM", () => shutdown(false))

async function control(request: Request): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return new Response("Unauthorized.", { status: 401 })
  }
  switch (request.method) {
    case "GET":
      return new Response(stopping ? "stopping" : "running")
    case "POST": {
      const action = await request.text()
      if (action !== "stop" && action !== "kill") {
        return new Response("Send stop or kill.", { status: 400 })
      }
      setTimeout(() => shutdown(action === "kill"), 0)
      return new Response("Stopping.", { status: 202 })
    }
    default:
      return new Response("GET or POST /control", { status: 405 })
  }
}

function shutdown(force: boolean): void {
  if (force && !forced) {
    forced = true
    failureAbort.abort()
    if (active !== null) {
      try {
        // Ask Codex to cancel its tools; see the Linux cleanup limitation in todo.md.
        process.kill(active.pid, "SIGINT")
      } catch {
        // A Codex process may have finished just before the stop request arrived.
      }
    }
  }
  if (stopping) return
  stopping = true
  void Promise.all([queue, hatches]).finally(finishShutdown)
}

function finishShutdown(): void {
  for (const subscriber of subscribers) subscriber.close()
  subscribers.length = 0
  unlinkSync(runPath)
  void server.stop(true)
}

function streamEvents(): Response {
  let subscriber: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      subscriber = controller
      subscribers.push(controller)
      controller.enqueue(encoder.encode(startup))
    },
    cancel() {
      const index = subscribers.indexOf(subscriber)
      if (index >= 0) subscribers.splice(index, 1)
    },
  })
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  })
}

function emit(line: string): void {
  process.stdout.write(line)
  const bytes = encoder.encode(line)
  for (const subscriber of subscribers) subscriber.enqueue(bytes)
}

function isStopping(): boolean {
  return stopping
}

async function hatch(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("POST a plain-text bird ID to /hatch", { status: 405 })
  }
  if (stopping) return new Response("Bird is stopping.", { status: 503 })
  const id = (await request.text()).trim()
  if (isStopping()) return new Response("Bird is stopping.", { status: 503 })
  let childDirectory: string
  try {
    childDirectory = birdDirectory(id, dirname(directory))
  } catch {
    return new Response("Bird ID must contain only letters, numbers, underscores, or hyphens.", {
      status: 400,
    })
  }
  // An unfinished upload has not been accepted. Only completed bodies join the
  // lifecycle drain, so a slow sender cannot prevent a bird from stopping.
  const response = hatchBird(childDirectory, id)
  hatches = Promise.all([hatches, response]).then(() => {})
  return response
}

async function hatchBird(childDirectory: string, id: string): Promise<Response> {
  try {
    const child = await createBird(childDirectory, id, {
      maxBirds: hatchMaxBirds,
      peers: `- ${nodeId} at ${address}`,
    })
    await startBird(child, true)
    return new Response(`Started ${child.id} at http://127.0.0.1:${child.port}/ask.`, { status: 201 })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return new Response("Bird ID already exists.", { status: 409 })
    }
    if (error instanceof Error && error.message === "Local bird limit reached.") {
      return new Response(error.message, { status: 429 })
    }
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 })
  }
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/ask") {
    return new Response("POST a plain-text message to /ask", { status: 404 })
  }
  if (stopping) return new Response("Bird is stopping.", { status: 503 })
  const incomingRequest = request.headers.get(headers.requestId)
  const inReplyTo = request.headers.get(headers.inReplyTo)
  if (incomingRequest !== null && inReplyTo !== null) {
    return new Response("Send either x-request or x-in-reply-to, not both.", { status: 400 })
  }
  const requestId = incomingRequest ?? inReplyTo ?? crypto.randomUUID()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return new Response("Request IDs must be canonical UUIDs.", { status: 400 })
  }
  const invocationId = crypto.randomUUID()
  const path = parsePath(request.headers.get(headers.route))
  if (path === null) {
    return reply(400, `${headers.route} must be a JSON array of node IDs`, { requestId })
  }
  const context: Context = {
    callerId: request.headers.get(headers.callerId) ?? "human",
    inReplyTo,
    invocationId,
    path,
    replyTo: request.headers.get(headers.replyTo),
    requestId,
  }
  const question = await request.text()
  if (isStopping()) return new Response("Bird is stopping.", { status: 503 })
  record(context, { kind: "received", question })
  // Usually a reply whose body never made it into curl; better to hear about it now.
  if (question.trim() === "") return reject(400, "Empty message.", context)
  // A message with no x-reply-to is fine: it may just share a fact or request an action.
  // A question that already went through this bird is a cycle; nothing else would
  // stop it going round forever. A reply is not a question, so its path is fine.
  if (inReplyTo === null && context.path.includes(nodeId)) {
    return reject(409, `Cycle rejected at ${nodeId}.`, context)
  }

  enqueueTurn(question, context)
  return reply(202, `Accepted by ${nodeId}.`, context)
}

function enqueueTurn(question: string, context: Context): void {
  // One Codex turn at a time: the conversation is a single thread.
  queue = queue.then(async () => {
    if (forced) return
    try {
      const threadId = await ask(question, context)
      record(context, { kind: "completed", threadId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A failed reply owes nobody anything; skipping it prevents failure loops.
      if (context.inReplyTo === null && context.replyTo !== null) {
        await reportFailure(context.replyTo, message, context)
      }
      record(context, { kind: "failed", error: message })
    }
  })
}

async function reportFailure(replyTo: string, message: string, context: Context): Promise<void> {
  await fetch(replyTo, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      [headers.callerId]: nodeId,
      [headers.inReplyTo]: context.requestId,
      [headers.route]: JSON.stringify(outgoingPath(context)),
      [headers.replyTo]: address,
    },
    body: message,
    signal: failureAbort.signal,
  }).catch(() => {})
}

async function ask(question: string, context: Context): Promise<string> {
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
  if (forced) throw new Error("Bird was killed.")
  const child = Bun.spawn([...codexCommand, ...args], {
    cwd: workspace,
    detached: true,
    env: {
      ...process.env,
      HUMMINGBIRDS_ROUTE: JSON.stringify(outgoingPath(context)),
      // Don't inherit removed messaging aliases from a parent process.
      HUMMINGBIRDS_NODE_ADDRESS: undefined,
      HUMMINGBIRDS_NODE_ID: undefined,
      HUMMINGBIRDS_REQUEST_ID: undefined,
    },
    stdin: new Blob([envelope(question, context)]),
    stdout: "pipe",
    stderr: "ignore",
  })
  active = child
  record(context, { kind: "started", codexPid: child.pid, threadId })
  const [startedThreadId, exitCode] = await Promise.all([
    readCodexOutput(child.stdout),
    child.exited,
  ])
  active = null

  if (threadId === null && startedThreadId !== null) {
    await Bun.write(`${threadIdPath}.tmp`, startedThreadId)
    await rename(`${threadIdPath}.tmp`, threadIdPath)
  }

  // Codex diagnostics can include credentials; never log or forward them to another bird.
  if (exitCode !== 0) throw new Error(`Codex exited with ${exitCode}`)
  if (startedThreadId === null) throw new Error("Codex did not report a thread ID")
  if (threadId !== null && startedThreadId !== threadId) {
    throw new Error(`Codex resumed thread ${startedThreadId} instead of ${threadId}`)
  }
  return startedThreadId
}

async function readCodexOutput(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const decoder = new TextDecoder()
  let pending = ""
  let startedThreadId: string | null = null

  function readLines(lines: string[]): void {
    for (const line of lines) {
      emit(`${line}\n`)
      if (!line.startsWith("{")) continue
      try {
        const event: unknown = JSON.parse(line)
        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "thread.started" &&
          "thread_id" in event &&
          typeof event.thread_id === "string"
        ) {
          startedThreadId = event.thread_id
        }
      } catch {
        // Diagnostics are still streamed even when they are not valid JSON.
      }
    }
  }

  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true })
    const newline = pending.lastIndexOf("\n")
    if (newline < 0) continue
    readLines(pending.slice(0, newline).split("\n"))
    pending = pending.slice(newline + 1)
  }
  pending += decoder.decode()
  if (pending !== "") readLines([pending])
  return startedThreadId
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
    `${headers.callerId}: ${context.callerId}`,
    context.inReplyTo === null
      ? `${headers.requestId}: ${context.requestId}`
      : `${headers.inReplyTo}: ${context.inReplyTo}`,
  ]
  if (context.replyTo !== null) lines.push(`${headers.replyTo}: ${context.replyTo}`)
  return `${lines.join("\n")}\n\n${question}`
}

function record(context: Context, event: Event): void {
  const { kind, ...details } = event
  const line = `${JSON.stringify({ ...context, ...details, at: Date.now(), kind })}\n`
  appendFileSync(eventsPath, line)
  emit(line)
}

function reject(status: number, body: string, context: Context): Response {
  record(context, { kind: "rejected", error: body })
  return reply(status, body, context)
}

function reply(status: number, body: string, context: Pick<Context, "requestId">): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
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
