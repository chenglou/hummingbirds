// One bird: an HTTP server that hands each message to a persistent Codex
// conversation. `bun start` keeps its directory in bird/, which holds:
//   thread-id     the Codex conversation to resume (created on the first message)
//   events.jsonl  a log of every message, for inspection only
//   workspace/    Codex's working directory, where AGENTS.md tells the bird who it is
// Nobody waits on the line: a message is acknowledged at once, the turn runs in its
// own time, and the bird POSTs whatever it has to say to the message's Reply-to address.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { rename } from "fs/promises"
import { basename, join, resolve } from "path"
import { createInterface } from "readline"

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

type Event = Context & {
  at: number
  kind: "received" | "rejected" | "started" | "completed" | "failed"
  nodeId: string
  question?: string
  threadId?: string | null
  codexPid?: number
  answer?: string
  error?: string
}

type CodexEvent = {
  type?: string
  thread_id?: string
  item?: { type?: string; text?: string }
}

const directory = resolve(Bun.env["HUMMINGBIRDS_DIRECTORY"] ?? "bird")
const nodeId = Bun.env["HUMMINGBIRDS_NODE_ID"] ?? basename(directory)
const codex = Bun.env["HUMMINGBIRDS_CODEX"] ?? "codex"
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
let queue: Promise<unknown> = Promise.resolve()

mkdirSync(workspace, { recursive: true })

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(Bun.env["HUMMINGBIRDS_PORT"] ?? 3000),
  fetch: handleRequest,
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
console.log(JSON.stringify({ id: nodeId, pid: process.pid, url: address }))
if (process.stdin.isTTY === true) void readTerminal().catch(console.error)

async function readTerminal(): Promise<void> {
  for await (const line of createInterface({ input: process.stdin, terminal: false })) {
    if (line.trim() === "") continue
    await handleRequest(new Request(address, { method: "POST", body: line }))
  }
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/ask") {
    return new Response("POST a plain-text message to /ask", { status: 404 })
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
  if (question.trim() === "") return reject(400, "Empty message.", context)
  // A message with no Reply-to is fine: a command, or a human who will read the log.
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
    const { answer, threadId } = await turn
    record(context, "completed", { answer, threadId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Nobody saw the turn fail, so tell the asker the same way the bird itself would
    // have, then put it on record. A failed reply turn owes nobody anything, and not
    // reporting it is what keeps two failing birds from bouncing reports forever.
    if (context.inReplyTo === null && context.replyTo !== null) {
      await reportFailure(message, context)
    }
    record(context, "failed", { error: message })
  }
}

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
      [headers.replyTo]: address,
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
  const [stdout, , exitCode] = await Promise.all([
    readCodexOutput(child.stdout),
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

  // Codex diagnostics can include credentials; never log or forward them to another bird.
  if (exitCode !== 0) throw new Error(`Codex exited with ${exitCode}`)
  if (startedThreadId === null) throw new Error("Codex did not report a thread ID")
  if (threadId !== null && startedThreadId !== threadId) {
    throw new Error(`Codex resumed thread ${startedThreadId} instead of ${threadId}`)
  }
  // What Codex says at the end of the turn reaches nobody; it is kept in the log.
  return { answer: answer ?? "", threadId: startedThreadId }
}

async function readCodexOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let output = ""
  for await (const chunk of stream) {
    process.stdout.write(chunk)
    output += decoder.decode(chunk, { stream: true })
  }
  return output + decoder.decode()
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
  const event: Event = { ...context, ...extra, at: Date.now(), kind, nodeId }
  const line = `${JSON.stringify(event)}\n`
  appendFileSync(eventsPath, line)
  process.stdout.write(line)
}

function reject(status: number, body: string, context: Context): Response {
  record(context, "rejected", { error: body })
  return reply(status, body, context)
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
