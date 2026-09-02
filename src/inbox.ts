type Reader = {
  controller: ReadableStreamDefaultController<Uint8Array>
  heartbeat: ReturnType<typeof setInterval>
  after: number
}

type Inbox = {
  id: string
  token: string
  nextSeq: number
  messages: { seq: number; data: Uint8Array }[]
  connection: { type: "idle"; since: number } | { type: "stream"; reader: Reader }
}

const maxMessageBytes = 64 * 1024
const maxInboxBytes = 1024 * 1024
const idleMs = 5 * 60 * 1000
const encoder = new TextEncoder()
const blank = encoder.encode("\n")
const closed = encoder.encode('{"type":"closed"}\n')

export function createInboxes(): { handle(request: Request): Promise<Response>; close(): void } {
  const inboxes: Inbox[] = []
  let stopped = false

  return { handle, close }

  async function handle(request: Request): Promise<Response> {
    if (stopped) return new Response("Inboxes are stopping.", { status: 503 })
    prune()
    const url = new URL(request.url)
    if (url.pathname === "/inboxes") {
      if (request.method !== "POST") return new Response("POST /inboxes", { status: 405 })
      if (inboxes.length >= 32) return new Response("All inboxes are occupied. Try again later.", { status: 503 })
      const inbox: Inbox = {
        id: crypto.randomUUID(),
        token: crypto.randomUUID(),
        nextSeq: 1,
        messages: [],
        connection: { type: "idle", since: Date.now() },
      }
      inboxes.push(inbox)
      return Response.json({ id: inbox.id, token: inbox.token }, {
        status: 201, headers: { "cache-control": "no-store" },
      })
    }

    const match = /^\/inboxes\/([^/]+)(?:\/(events))?$/.exec(url.pathname)
    const inbox = inboxes.find((candidate) => candidate.id === match?.[1])
    if (inbox === undefined) return new Response("Inbox not found or expired.", { status: 404 })
    if (match?.[2] === undefined && request.method === "POST") return receive(request, inbox)
    if (request.headers.get("authorization") !== `Bearer ${inbox.token}`) {
      return new Response("Unauthorized.", { status: 401 })
    }
    if (match?.[2] === "events") {
      if (request.method !== "GET") return new Response("GET the inbox stream.", { status: 405 })
      const cursor = url.searchParams.get("after") ?? "0"
      const after = Number(cursor)
      if (!/^(0|[1-9]\d*)$/.test(cursor) || !Number.isSafeInteger(after) || after >= inbox.nextSeq) {
        return new Response("Invalid inbox cursor.", { status: 400 })
      }
      const first = inbox.messages[0]
      if (first !== undefined && after < first.seq - 1) {
        return new Response("Inbox history no longer contains that cursor. Start a new chat.", { status: 409 })
      }
      return stream(inbox, after)
    }
    if (request.method !== "DELETE") return new Response("POST a plain-text message or DELETE the inbox.", { status: 405 })
    finishReader(inbox)
    inboxes.splice(inboxes.indexOf(inbox), 1)
    return new Response(null, { status: 204 })
  }

  async function receive(request: Request, inbox: Inbox): Promise<Response> {
    const incomingRequest = request.headers.get("x-request")
    const inReplyTo = request.headers.get("x-in-reply-to")
    if (incomingRequest !== null && inReplyTo !== null) {
      return new Response("Send either x-request or x-in-reply-to, not both.", { status: 400 })
    }
    const requestId = incomingRequest ?? inReplyTo ?? crypto.randomUUID()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      return new Response("Request IDs must be canonical UUIDs.", { status: 400 })
    }
    let body = ""
    let bytes = 0
    const decoder = new TextDecoder()
    try {
      if (request.body !== null) {
        for await (const chunk of request.body) {
          bytes += chunk.byteLength
          if (bytes > maxMessageBytes) return new Response("Message exceeds 64 KiB.", { status: 413 })
          body += decoder.decode(chunk, { stream: true })
        }
      }
      body += decoder.decode()
    } catch {
      return new Response("Could not read the message body.", { status: 400 })
    }
    if (body.trim() === "") return new Response("Empty message.", { status: 400 })
    prune()
    if (!inboxes.includes(inbox)) return new Response("Inbox not found or expired.", { status: 404 })
    const seq = inbox.nextSeq
    const data = encoder.encode(JSON.stringify({
      type: "message", seq, from: request.headers.get("x-from") ?? "unknown", body, requestId, inReplyTo,
    }) + "\n")
    if (data.byteLength > maxMessageBytes) return new Response("Message exceeds 64 KiB.", { status: 413 })
    inbox.nextSeq += 1
    inbox.messages.push({ seq, data })
    while (inbox.messages.length > 100 || inbox.messages.reduce((sum, message) => sum + message.data.byteLength, 0) > maxInboxBytes) {
      inbox.messages.shift()
    }
    if (inbox.connection.type === "stream") pump(inbox, inbox.connection.reader)
    return new Response("Accepted by inbox.", {
      status: 202,
      headers: { "content-type": "text/plain; charset=utf-8", "x-request": requestId },
    })
  }

  function stream(inbox: Inbox, after: number): Response {
    finishReader(inbox)
    let reader: Reader
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        reader = {
          controller,
          after,
          heartbeat: setInterval(() => {
            if ((controller.desiredSize ?? 0) > 0) controller.enqueue(blank)
          }, 15_000),
        }
        inbox.connection = { type: "stream", reader }
        controller.enqueue(blank)
      },
      pull() { pump(inbox, reader) },
      cancel() { disconnect(inbox, reader) },
    }), {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
    })
  }

  function pump(inbox: Inbox, reader: Reader): void {
    if (inbox.connection.type !== "stream" || inbox.connection.reader !== reader) return
    const first = inbox.messages[0]
    if (first !== undefined && reader.after < first.seq - 1) {
      disconnect(inbox, reader)
      reader.controller.error(new Error("Inbox history exhausted by a slow reader."))
      return
    }
    const message = inbox.messages.find((candidate) => candidate.seq > reader.after)
    if (message !== undefined && (reader.controller.desiredSize ?? 0) > 0) {
      reader.after = message.seq
      reader.controller.enqueue(message.data)
    }
  }

  function disconnect(inbox: Inbox, reader: Reader): void {
    clearInterval(reader.heartbeat)
    if (inbox.connection.type === "stream" && inbox.connection.reader === reader) {
      inbox.connection = { type: "idle", since: Date.now() }
    }
  }

  function finishReader(inbox: Inbox): void {
    if (inbox.connection.type === "stream") {
      const reader = inbox.connection.reader
      disconnect(inbox, reader)
      reader.controller.enqueue(closed)
      reader.controller.close()
    }
  }

  function prune(): void {
    const now = Date.now()
    for (let index = inboxes.length - 1; index >= 0; index -= 1) {
      const inbox = inboxes[index]
      if (inbox !== undefined && inbox.connection.type === "idle" && now - inbox.connection.since >= idleMs) {
        inboxes.splice(index, 1)
      }
    }
  }

  function close(): void {
    stopped = true
    for (const inbox of inboxes) finishReader(inbox)
    inboxes.length = 0
  }
}
