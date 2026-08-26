// One bird: an HTTP server that hands each message to a persistent Codex
// conversation. `bun start` keeps its directory in bird/, which holds:
//   thread-id     the Codex conversation to resume (created on the first message)
//   events.jsonl  a log of every message, for inspection only
//   workspace/    Codex's working directory, where AGENTS.md tells the bird who it is
// Nobody waits on the line: a message is acknowledged at once, the turn runs in its
// own time, and the bird POSTs whatever it has to say to the message's x-reply-to address.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "fs"
import { rename } from "fs/promises"
import { basename, dirname, join, resolve } from "path"

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
const nodeId = Bun.env["HUMMINGBIRDS_NODE_ID"] ?? basename(directory)
const executable = Bun.env["HUMMINGBIRDS_CODEX"]
const codex = executable === undefined
  ? [process.execPath, require.resolve("@openai/codex/bin/codex.js")]
  : [executable]
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
let queue: Promise<unknown> = Promise.resolve()

mkdirSync(workspace, { recursive: true })

const server = Bun.serve({
  hostname: "127.0.0.1",
  idleTimeout: 0,
  port: Number(Bun.env["HUMMINGBIRDS_PORT"] ?? 3000),
  fetch: (request) => {
    switch (new URL(request.url).pathname) {
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
const agentsPath = join(workspace, "AGENTS.md")
if (!existsSync(agentsPath)) {
  const prompt = readFileSync(join(import.meta.dir, "prompt_template.md"), "utf8")
  writeFileSync(
    agentsPath,
    prompt
      .replaceAll("[id]", nodeId)
      .replaceAll("[address]", address)
      .replaceAll("[peers]", Bun.env["HUMMINGBIRDS_PEERS"] ?? "(none)")
      .replaceAll("[seed]", Bun.env["HUMMINGBIRDS_SEED"] ?? "(none)"),
  )
}
const startup = `${JSON.stringify({ id: nodeId, pid: process.pid, url: address })}\n`
emit(startup)

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

async function hatch(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("POST a plain-text bird ID to /hatch", { status: 405 })
  }
  const id = (await request.text()).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    return new Response("Bird ID must contain only letters, numbers, underscores, or hyphens.", {
      status: 400,
    })
  }
  const flockDirectory = dirname(directory)
  const childDirectory = join(flockDirectory, `bird-${id}`)
  // Reserve before counting so concurrent birds cannot both keep the last slot.
  try {
    mkdirSync(childDirectory)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return new Response("Bird ID already exists.", { status: 409 })
    }
    throw error
  }
  const births = readdirSync(flockDirectory, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("bird-"),
  ).length
  if (births > hatchMaxBirds) {
    rmdirSync(childDirectory)
    return new Response("Local bird limit reached.", { status: 429 })
  }

  const outputPath = join(childDirectory, "stdout.jsonl")
  const child = Bun.spawn([process.execPath, import.meta.path], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      HUMMINGBIRDS_DIRECTORY: childDirectory,
      HUMMINGBIRDS_NODE_ID: id,
      HUMMINGBIRDS_PEERS: `- ${nodeId} at ${address}`,
      HUMMINGBIRDS_PORT: "0",
      HUMMINGBIRDS_SEED: "(none)",
    },
    stdin: "ignore",
    stdout: Bun.file(outputPath),
    stderr: "ignore",
  })
  child.unref()

  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(outputPath)) {
      const text = readFileSync(outputPath, "utf8")
      const newline = text.indexOf("\n")
      if (newline >= 0) {
        const started = JSON.parse(text.slice(0, newline)) as { id: string; url: string }
        return new Response(`Started ${started.id} at ${started.url}.`, { status: 201 })
      }
    }
    if (child.exitCode !== null) {
      return new Response("Bird exited before starting.", { status: 500 })
    }
    await Bun.sleep(10)
  }
  child.kill()
  return new Response("Bird did not start in time.", { status: 500 })
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/ask") {
    return new Response("POST a plain-text message to /ask", { status: 404 })
  }
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
  record(context, { kind: "received", question })
  // Usually a reply whose body never made it into curl; better to hear about it now.
  if (question.trim() === "") return reject(400, "Empty message.", context)
  // A message with no x-reply-to is fine: it may just share a fact or request an action.
  // A question that already went through this bird is a cycle; nothing else would
  // stop it going round forever. A reply is not a question, so its path is fine.
  if (inReplyTo === null && context.path.includes(nodeId)) {
    return reject(409, `Cycle rejected at ${nodeId}.`, context)
  }

  void runTurn(question, context)
  return reply(202, `Accepted by ${nodeId}.`, context)
}

async function runTurn(question: string, context: Context): Promise<void> {
  // One Codex turn at a time: the conversation is a single thread.
  const turn = queue.then(() => ask(question, context))
  queue = turn.catch(() => {})
  try {
    const threadId = await turn
    record(context, { kind: "completed", threadId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Nobody saw the turn fail, so tell the asker the same way the bird itself would
    // have, then put it on record. A failed reply turn owes nobody anything, and not
    // reporting it is what keeps two failing birds from bouncing reports forever.
    if (context.inReplyTo === null && context.replyTo !== null) {
      await reportFailure(context.replyTo, message, context)
    }
    record(context, { kind: "failed", error: message })
  }
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
  const child = Bun.spawn([...codex, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      HUMMINGBIRDS_NODE_ADDRESS: address,
      HUMMINGBIRDS_NODE_ID: nodeId,
      HUMMINGBIRDS_ROUTE: JSON.stringify(outgoingPath(context)),
      HUMMINGBIRDS_REQUEST_ID: context.requestId,
    },
    stdin: new Blob([envelope(question, context)]),
    stdout: "pipe",
    stderr: "ignore",
  })
  record(context, { kind: "started", codexPid: child.pid, threadId })
  const [startedThreadId, exitCode] = await Promise.all([
    readCodexOutput(child.stdout),
    child.exited,
  ])

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
