import { createInterface } from "readline"

type Peer = { address: string; id: string }
type Turn = { callerId: string; replyTo: string | null }
class ChatProtocolError extends Error {}

export async function chat(target: string): Promise<void> {
  const origin = destination(target)
  const address = origin.href
  const created = await fetch(new URL("/inboxes", origin), { method: "POST", signal: AbortSignal.timeout(10_000) })
  if (!created.ok) {
    throw new Error(created.status === 404
      ? "This bird does not support hosted reply inboxes. Update its installation and restart it."
      : `Could not open a reply inbox (${created.status}): ${await created.text()}`)
  }
  const inbox: unknown = await created.json().catch(() => null)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (typeof inbox !== "object" || inbox === null
    || !("id" in inbox) || typeof inbox.id !== "string" || !uuid.test(inbox.id)
    || !("token" in inbox) || typeof inbox.token !== "string" || !uuid.test(inbox.token)) {
    throw new Error("The server returned an invalid reply inbox.")
  }
  const inboxURL = new URL(`/inboxes/${inbox.id}`, origin)
  const inboxAddress = inboxURL.href
  const authorization = `Bearer ${inbox.token}`
  const abort = new AbortController()

  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true
  const peers: Peer[] = []
  let nodeId = "bird"
  let active: Turn | null = null
  let after = 0
  let streamError: unknown = null
  const background = 101 + Number(Bun.hash.wyhash("human") % 6n)
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `\x1b[30;${background}m You \x1b[0m `,
    terminal: interactive,
  })

  const stop = () => {
    abort.abort()
    input.close()
  }
  input.on("SIGINT", stop)
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  process.on("SIGHUP", stop)
  if (interactive) {
    input.prompt()
  }
  const streaming = Promise.all([follow("events"), follow("inbox")]).catch((error: unknown) => {
    if (!abort.signal.aborted) {
      streamError = error
      stop()
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
          signal: abort.signal,
        })
        if (!sent.ok) throw new Error(`${address} returned ${sent.status}: ${await sent.text()}`)
      }
      if (interactive) render("")
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error
  } finally {
    stop()
    await streaming
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    process.off("SIGHUP", stop)
    try {
      await fetch(inboxURL, { method: "DELETE", headers: { authorization }, signal: AbortSignal.timeout(2000) })
    } catch {
      // A disconnected inbox expires on the server even if cleanup cannot reach it.
    }
  }
  if (streamError !== null) throw streamError

  async function follow(kind: "inbox" | "events"): Promise<void> {
    let disconnectedAt: number | null = null
    while (!isStopped()) {
      const connection = new AbortController()
      let lastDataAt: number | null = null
      let reason = "Stream ended."
      let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => connection.abort(new Error("Timed out waiting for stream headers (10s)")), 10_000,
      )
      try {
        const url = kind === "inbox" ? `${inboxURL.href}/events?after=${after}` : new URL("/events", origin)
        const response = await fetch(url, {
          headers: kind === "inbox" ? { authorization } : {},
          signal: AbortSignal.any([abort.signal, connection.signal]),
        })
        clearTimeout(timeout)
        if (!response.ok) {
          const error = kind === "inbox" && response.status === 404
            ? "Reply inbox expired or the server restarted. Start a new chat."
            : kind === "inbox" && response.status === 409
              ? "Reply inbox buffer was exceeded; some replies may be missing. Start a new chat."
              : `${kind} stream returned ${response.status}`
          if (response.status < 500) throw new ChatProtocolError(error)
          throw new Error(error)
        }
        if (response.body === null) throw new ChatProtocolError(`${kind} did not provide an event stream`)
        if (kind === "inbox") timeout = setTimeout(
          () => connection.abort(new Error("No reply-stream data received for 45s")), 45_000,
        )
        const decoder = new TextDecoder()
        let pending = ""
        for await (const chunk of response.body) {
          clearTimeout(timeout)
          if (kind === "inbox") timeout = setTimeout(
            () => connection.abort(new Error("No reply-stream data received for 45s")), 45_000,
          )
          lastDataAt = Date.now()
          disconnectedAt = null
          pending += decoder.decode(chunk, { stream: true })
          let newline = pending.indexOf("\n")
          while (newline >= 0) {
            const line = pending.slice(0, newline)
            if (kind === "inbox") deliver(line)
            else display(line)
            pending = pending.slice(newline + 1)
            newline = pending.indexOf("\n")
          }
        }
        // Incomplete lines belong to this connection. Replayed inbox messages start
        // after the last fully displayed sequence number, never a partial chunk.
      } catch (error) {
        if (error instanceof ChatProtocolError) throw error
        if (abort.signal.aborted) return
        reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        if (error instanceof Error && "code" in error && (typeof error.code === "string" || typeof error.code === "number")) {
          reason += ` (code ${error.code})`
        }
      } finally {
        clearTimeout(timeout)
        connection.abort()
      }
      if (abort.signal.aborted) return
      if (disconnectedAt === null) {
        disconnectedAt = Date.now()
        const quiet = lastDataAt === null ? "no data received" : `${disconnectedAt - lastDataAt}ms since last data`
        console.error(`[${new Date(disconnectedAt).toISOString()}] ${kind === "inbox" ? "Reply" : "Bird event"} stream disconnected; reconnecting… ${JSON.stringify(reason)} (${quiet})`)
      }
      if (Date.now() - disconnectedAt >= 5 * 60 * 1000) {
        throw new Error("Could not reconnect to the bird. Start a new chat when it is reachable.")
      }
      await Bun.sleep(500)
    }
  }

  function isStopped(): boolean {
    return abort.signal.aborted
  }

  function deliver(line: string): void {
    if (line === "") return
    let message: unknown
    try { message = JSON.parse(line) } catch { throw new ChatProtocolError("Invalid reply stream.") }
    if (typeof message !== "object" || message === null || !("type" in message)) {
      throw new ChatProtocolError("Invalid reply stream.")
    }
    if (message.type === "closed") {
      stop()
      return
    }
    if (message.type !== "message"
      || !("seq" in message) || typeof message.seq !== "number" || !Number.isSafeInteger(message.seq) || message.seq < 1
      || !("from" in message) || typeof message.from !== "string"
      || !("body" in message) || typeof message.body !== "string") {
      throw new ChatProtocolError("Invalid reply stream.")
    }
    if (message.seq <= after) return
    if (message.seq !== after + 1) throw new ChatProtocolError("Reply stream skipped a message. Start a new chat.")
    render(formatMessage(message.from, message.body, message.from))
    after = message.seq
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
              replyTo: "replyTo" in event && typeof event.replyTo === "string" ? messageAddress(event.replyTo) : null,
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
    if (pretty !== "") render(`\x1b[90m${pretty}\x1b[0m`)
  }

  function remember(id: string, peerAddress: string): void {
    const address = messageAddress(peerAddress)
    if (id === "human" || address === null) return
    const known = peers.find((peer) => peer.address === address)
    if (known === undefined) peers.push({ id, address })
    else known.id = id
  }

  function outgoingMessage(command: string): { address: string; recipient: string; message: string } | null {
    let words = shellWords(command)
    if (/^(?:.*\/)?(?:ba|z)?sh$/.test(words[0] ?? "")) {
      const script = words.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word))
      if (script < 0) return null
      words = shellWords(words[script + 1] ?? "")
    }

    const curl = words.findIndex((word) => word === "curl" || word.endsWith("/curl"))
    if (curl < 0) return null
    let target: string | null = null
    let message: string | null = null
    let method: string | null = null
    for (let index = curl + 1; index < words.length; index += 1) {
      const word = words[index] ?? ""
      if ([";", "&&", "||", "|", "&"].includes(word)) break
      const argument = /^(--[a-z-]+)(?:=(.*))?$|^(-[A-Za-z])(.+)?$/.exec(word)
      const option = argument?.[1] ?? argument?.[3] ?? word
      const data = ["-d", "--data", "--data-binary", "--data-raw"].includes(option)
      if (data || ["-H", "--header", "-X", "--request", "--url", "-e", "--referer",
        "-o", "--output", "-w", "--write-out", "-u", "--user", "-A", "--user-agent",
        "-m", "--max-time", "--connect-timeout", "--retry", "--retry-delay"].includes(option)) {
        const value = argument?.[2] ?? argument?.[4] ?? words[++index]
        if (value === undefined) return null
        if (data) {
          if (message !== null) return null
          message = value
        } else if (option === "-X" || option === "--request") method = value
        else if (option === "--url") {
          if (target !== null) return null
          target = value
        }
      } else if (/^-[sSfLk]+$/.test(word)
        || /^--(?:silent|show-error|fail|fail-with-body|location|insecure|compressed|retry-all-errors|retry-connrefused)$/.test(word)) {
        continue
      } else {
        // Unknown options can consume URL-looking values. Don't guess their destination.
        if (word.startsWith("-") || target !== null) return null
        target = word
      }
    }
    if (target === null || message === null || (method !== null && method !== "POST")) return null
    const address = messageAddress(target)
    if (address === null) return null

    const recipient = active?.replyTo === address
      ? active.callerId
      : (peers.find((peer) => peer.address === address)?.id ?? address)
    return { address, recipient, message }
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

function messageAddress(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
  } catch {
    return null
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
    throw new Error("Specify the bird's origin or port, without a path, query, or fragment")
  }
  return parsed
}
