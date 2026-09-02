import { createInterface } from "readline"
import { httpOrigin, isLoopbackHost, networkSettings, type Network } from "./network.ts"

type Peer = { address: string; id: string }
type Turn = { callerId: string; replyTo: string | null }

export async function chat(target: string, options: Partial<Network> & { port?: number } = {}): Promise<void> {
  const origin = destination(target)
  const network = networkSettings(options.host, options.bind)
  const port = options.port ?? 0
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Chat callback port must be an integer from 0 to 65535.")
  }
  if (!isLoopbackHost(origin.hostname) && isLoopbackHost(network.host)) {
    throw new Error("Remote birds cannot reach a loopback chat callback. Set BIRDS_HOST to this machine's reachable address.")
  }
  const address = new URL("/ask", origin).href
  const events = new URL("/events", origin).href
  const abort = new AbortController()
  const response = await fetch(events, { signal: abort.signal })
  if (!response.ok || response.body === null) {
    abort.abort()
    throw new Error(!response.ok
      ? `${events} returned ${response.status}`
      : `${events} did not provide an event stream`)
  }

  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true
  const peers: Peer[] = []
  let nodeId = "bird"
  let active: Turn | null = null

  let inbox: ReturnType<typeof Bun.serve>
  try {
    inbox = Bun.serve({
      hostname: network.bind,
      port,
      async fetch(request) {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/ask") {
          return new Response("POST a plain-text message to /ask", { status: 404 })
        }
        const incomingRequest = request.headers.get("x-request")
        const inReplyTo = request.headers.get("x-in-reply-to")
        if (incomingRequest !== null && inReplyTo !== null) {
          return new Response("Send either x-request or x-in-reply-to, not both.", { status: 400 })
        }
        const requestId = incomingRequest ?? inReplyTo ?? crypto.randomUUID()
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
          return new Response("Request IDs must be canonical UUIDs.", { status: 400 })
        }
        const question = await request.text()
        if (question.trim() === "") return new Response("Empty message.", { status: 400 })

        const callerId = request.headers.get("x-from") ?? "unknown"
        render(formatMessage(callerId, question, callerId))
        return new Response("Accepted by human.", {
          status: 202,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-request": requestId,
          },
        })
      },
    })
  } catch (error) {
    abort.abort()
    throw error
  }
  const inboxPort = inbox.port
  if (inboxPort === undefined) {
    abort.abort()
    await inbox.stop(true)
    throw new Error("Could not determine the chat callback port.")
  }
  const inboxAddress = new URL("/ask", httpOrigin(network.host, inboxPort)).href
  const background = 101 + Number(Bun.hash.wyhash("human") % 6n)
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `\x1b[30;${background}m You \x1b[0m `,
    terminal: interactive,
  })

  if (interactive) {
    input.on("SIGINT", () => input.close())
    input.prompt()
  }
  const streaming = readEvents(response.body)
    .then(() => {
      if (!abort.signal.aborted) input.close()
    })
    .catch((error: unknown) => {
      if (!abort.signal.aborted) {
        console.error(error)
        input.close()
      }
    })

  try {
    for await (const line of input) {
      if (line.trim() !== "") {
        const sent = await fetch(address, {
          method: "POST",
          headers: {
            "x-from": "human",
            "x-reply-to": inboxAddress,
          },
          body: line,
        })
        if (!sent.ok) throw new Error(`${address} returned ${sent.status}: ${await sent.text()}`)
      }
      if (interactive) render("")
    }
  } finally {
    input.close()
    abort.abort()
    await streaming
    await inbox.stop(true)
  }

  async function readEvents(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let pending = ""
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true })
      let newline = pending.indexOf("\n")
      while (newline >= 0) {
        display(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf("\n")
      }
    }
    pending += decoder.decode()
    if (pending !== "") display(pending)
  }

  function display(line: string): void {
    if (line === "") return
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return
    }

    let pretty = ""
    if (typeof event === "object" && event !== null) {
      if ("id" in event && typeof event.id === "string") nodeId = event.id
      if ("kind" in event) {
        switch (event.kind) {
          case "received": {
            if (!("callerId" in event) || typeof event.callerId !== "string") break
            if ("replyTo" in event && typeof event.replyTo === "string") remember(event.callerId, event.replyTo)
            if (event.callerId !== "human" && "question" in event && typeof event.question === "string") {
              pretty = formatMessage(`← ${event.callerId}`, event.question)
            }
            break
          }
          case "started": {
            if (!("callerId" in event) || typeof event.callerId !== "string") break
            active = {
              callerId: event.callerId,
              replyTo: "replyTo" in event && typeof event.replyTo === "string" ? event.replyTo : null,
            }
            break
          }
          case "completed":
          case "failed":
            active = null
            break
          default:
            break
        }
      } else if ("type" in event) {
        switch (event.type) {
          case "item.started": {
            if (!("item" in event) || typeof event.item !== "object" || event.item === null) break
            if (!("type" in event.item) || event.item.type !== "command_execution") break
            if (!("command" in event.item) || typeof event.item.command !== "string") break
            const outgoing = outgoingMessage(event.item.command)
            if (outgoing !== null && outgoing.address !== inboxAddress) {
              pretty = formatMessage(`→ ${outgoing.recipient}`, outgoing.message)
            }
            break
          }
          case "item.completed": {
            if (!("item" in event) || typeof event.item !== "object" || event.item === null) break
            if (!("type" in event.item) || event.item.type !== "agent_message") break
            if (!("text" in event.item) || typeof event.item.text !== "string") break
            if (event.item.text !== "") pretty = formatMessage(`${nodeId}:`, event.item.text)
            break
          }
          default:
            break
        }
      }
    }
    if (pretty !== "") render(pretty)
  }

  function remember(id: string, peerAddress: string): void {
    if (id === "human") return
    const known = peers.find((peer) => peer.address === peerAddress)
    if (known === undefined) peers.push({ id, address: peerAddress })
    else known.id = id
  }

  function outgoingMessage(command: string): { address: string; recipient: string; message: string } | null {
    let words = shellWords(command)
    const script = words.find((word) => /(?:^|\s)(?:\S+\/)?curl\s/.test(word))
    if (script !== undefined) words = shellWords(script)

    const curl = words.findIndex((word) => word === "curl" || word.endsWith("/curl"))
    if (curl < 0) return null
    const target = words.slice(curl + 1).find((word) => /^https?:\/\/\S+\/ask(?:\?\S*)?$/.test(word))
    if (target === undefined) return null
    const data = words.findIndex((word) => /^(?:--data(?:-binary|-raw)?|-d)(?:=.*)?$/.test(word))
    const option = words[data]
    if (option === undefined) return null
    const separator = option.indexOf("=")
    const message = separator < 0 ? words[data + 1] : option.slice(separator + 1)
    if (message === undefined) return null

    const recipient = active?.replyTo === target
      ? active.callerId
      : (peers.find((peer) => peer.address === target)?.id ?? target)
    return { address: target, recipient, message }
  }

  function render(text: string): void {
    if (!interactive) {
      process.stdout.write(text)
      return
    }
    process.stdout.write(`\r\x1b[2K${text}`)
    input.prompt(true)
    process.stdout.write(input.line)
  }
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
      const escaped = command.charAt(index + 1)
      if (quote === '"' && !"$`\"\\\n".includes(escaped)) {
        word += character
      } else {
        index += 1
        if (escaped !== "\n") word += escaped
      }
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

function formatMessage(label: string, text: string, sender?: string): string {
  const message = Bun.stripANSI(text).replaceAll("\n", "\n    ")
  if (sender === undefined) return `${Bun.stripANSI(label)}${label.endsWith(":") ? " " : "  "}${message}\n`
  const shade = 101 + Number(Bun.hash.wyhash(sender) % 6n)
  return `\x1b[30;${shade}m ${Bun.stripANSI(label)} \x1b[0m ${message}\n`
}

function destination(requested: string): URL {
  const source = /^\d+$/.test(requested)
    ? `http://127.0.0.1:${requested}`
    : /^https?:\/\//.test(requested)
      ? requested
      : `http://${requested}`
  const parsed = new URL(source)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Bird addresses must use http or https")
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Specify the bird's origin or port, without /ask or /events")
  }
  return parsed
}
