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
import { createInterface, type Interface } from "readline"

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
  question?: string
  threadId?: string | null
  codexPid?: number
  error?: string
}

type CodexEvent = {
  type?: string
  thread_id?: string
  item?: { type?: string; text?: string; command?: string }
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
const interactive = process.stdout.isTTY === true
let queue: Promise<unknown> = Promise.resolve()
let terminal: Interface | null = null

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
  const background = 101 + Number(Bun.hash.wyhash("human") % 6n)
  const prompt = `\x1b[30;${background}m You \x1b[0m `
  const input = createInterface({ input: process.stdin, output: process.stdout, prompt, terminal: interactive })
  if (interactive) {
    terminal = input
    input.on("SIGINT", () => {
      input.close()
      process.kill(process.pid, "SIGINT")
    })
    input.prompt()
  }
  for await (const line of input) {
    if (line.trim() !== "") {
      await handleRequest(new Request(address, { method: "POST", body: line }))
    }
    if (interactive) renderTerminal("")
  }
  if (terminal === input) terminal = null
}

function renderTerminal(text: string): void {
  if (terminal === null) {
    process.stdout.write(text)
    return
  }
  process.stdout.write(`\r\x1b[2K${text}`)
  terminal.prompt(true)
  process.stdout.write(terminal.line)
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
    const threadId = await turn
    record(context, "completed", { threadId })
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
  const [startedThreadId, , exitCode] = await Promise.all([
    readCodexOutput(child.stdout, context),
    new Response(child.stderr).text(),
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

async function readCodexOutput(
  stream: ReadableStream<Uint8Array>,
  context: Context,
): Promise<string | null> {
  const decoder = new TextDecoder()
  let pending = ""
  let startedThreadId: string | null = null

  function readLines(lines: string[]): void {
    let display = ""
    for (const line of lines) {
      const event = parseEvent(line)
      if (event?.type === "thread.started") startedThreadId = event.thread_id ?? null
      if (!interactive) continue
      display += `\x1b[90m${line}\x1b[0m\n`
      if (
        event?.type === "item.started" &&
        event.item?.type === "command_execution" &&
        event.item.command !== undefined
      ) {
        const outgoing = outgoingMessage(event.item.command, context)
        if (outgoing !== null) {
          display += formatMessage(`→ ${outgoing.recipient}`, outgoing.message)
        }
      }
      if (
        event?.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        event.item.text !== undefined &&
        event.item.text !== ""
      ) {
        display += formatMessage(`${nodeId} (self)`, event.item.text, nodeId)
      }
    }
    if (interactive) renderTerminal(display)
  }

  for await (const chunk of stream) {
    if (!interactive) process.stdout.write(chunk)
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

function outgoingMessage(
  command: string,
  context: Context,
): { recipient: string; message: string } | null {
  let words = shellWords(command)
  const script = words.find((word) => /(?:^|\s)(?:\S+\/)?curl\s/.test(word))
  if (script !== undefined) words = shellWords(script)

  const curl = words.findIndex((word) => word === "curl" || word.endsWith("/curl"))
  if (curl < 0) return null
  const target = words
    .slice(curl + 1)
    .find((word) => /^https?:\/\/\S+\/ask(?:\?\S*)?$/.test(word))
  if (target === undefined) return null

  const data = words.findIndex((word) => /^(?:--data(?:-binary|-raw)?|-d)(?:=.*)?$/.test(word))
  const option = words[data]
  if (option === undefined) return null
  const separator = option.indexOf("=")
  const message = separator < 0 ? words[data + 1] : option.slice(separator + 1)
  if (message === undefined) return null

  if (context.replyTo === target) return { recipient: context.callerId, message }
  const configuredPeers = Bun.env["HUMMINGBIRDS_PEERS"] ?? readFileSync(agentsPath, "utf8")
  for (const match of configuredPeers.matchAll(/^\s*-\s+(\S+)\s+at\s+(\S+)/gm)) {
    if (match[2] === target) return { recipient: match[1] ?? target, message }
  }
  return { recipient: target, message }
}

function shellWords(command: string): string[] {
  const words: string[] = []
  let word = ""
  let quote: "'" | '"' | null = null

  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index)
    if (character === quote) {
      quote = null
    } else if (quote === null && (character === "'" || character === '"')) {
      quote = character
    } else if (character === "\\" && quote !== "'") {
      index += 1
      const escaped = command.charAt(index)
      if (escaped !== "\n") word += escaped
    } else if (quote === null && /\s/.test(character)) {
      if (word !== "") words.push(word)
      word = ""
    } else {
      word += character
    }
  }
  if (word !== "") words.push(word)
  return words
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
  const event: Event = { ...context, ...extra, at: Date.now(), kind }
  const line = `${JSON.stringify(event)}\n`
  appendFileSync(eventsPath, line)
  if (!interactive) {
    process.stdout.write(line)
    return
  }
  let display = `\x1b[90m${line.slice(0, -1)}\x1b[0m\n`
  if (kind === "received" && context.callerId !== "human") {
    display += formatMessage(`← ${context.callerId}`, extra.question ?? "")
  }
  renderTerminal(display)
}

function formatMessage(label: string, text: string, sender?: string): string {
  const message = Bun.stripANSI(text).replaceAll("\n", "\n    ")
  if (sender === undefined) return `${Bun.stripANSI(label)}  ${message}\n`
  const background = 101 + Number(Bun.hash.wyhash(sender) % 6n)
  return `\x1b[30;${background}m ${Bun.stripANSI(label)} \x1b[0m ${message}\n`
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
