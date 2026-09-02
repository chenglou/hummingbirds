import { describe, expect, test } from "bun:test"
import { resolve } from "path"
import { createInboxes } from "../src/inbox.ts"

type Credentials = { id: string; token: string }
type RequestRecord = {
  url: string
  method: string
  authorization: string | null
  from: string | null
  replyTo: string | null
  body: string
}

const chatModule = resolve(import.meta.dir, "../src/chat.ts")
const encoder = new TextEncoder()

describe("hosted chat", () => {
  test.each(["http://birds.test/ask", "https://birds.test/?key=bad", "https://birds.test/#bad"])(
    "rejects a non-origin destination before network access: %s",
    async (target) => {
      const client = launchChat(target, 'globalThis.fetch = () => { throw new Error("UNEXPECTED_FETCH") }')
      try {
        const result = await client.finished
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("without /ask or /events")
        expect(result.stderr).not.toContain("UNEXPECTED_")
      } finally {
        await stopChat(client)
      }
    },
  )

  test("uses a remote HTTPS origin, ordinary POSTs, and a private receive token without a local listener", async () => {
    const bird = fixture()
    const origin = "https://public-bird.example:8443"
    const client = launchChat(origin, `
      const nativeFetch = globalThis.fetch
      globalThis.fetch = (target, options) => {
        const url = new URL(target instanceof Request ? target.url : String(target))
        if (url.origin !== ${JSON.stringify(origin)}) throw new Error("Unexpected request origin: " + url.origin)
        return nativeFetch(new URL(url.pathname + url.search, ${JSON.stringify(bird.origin)}), options)
      }
    `)
    try {
      await waitUntil(() => client.output.stdout.includes("CHAT_READY"))
      await client.child.stdin.write("Hello remote bird.\n")
      await waitUntil(() => bird.requests.some((request) => request.method === "POST" && new URL(request.url).pathname === "/ask"))
      const sent = bird.requests.find((request) => new URL(request.url).pathname === "/ask")
      const inbox = bird.allocations[0]
      if (sent === undefined || inbox === undefined) throw new Error("Missing chat request or inbox")
      expect(sent).toMatchObject({
        from: "human", authorization: null, body: "Hello remote bird.",
        replyTo: `${origin}/inboxes/${inbox.id}/ask`,
      })
      const requestId = crypto.randomUUID()
      const reply = await post(bird, inbox, "\x1b[31mWhisper received: café 🐦\x1b[0m\nsecond line\n第三行", {
        "x-from": "remote-bird", "x-in-reply-to": requestId,
      })
      expect(reply.status).toBe(202)
      expect(reply.headers.get("x-request")).toBe(requestId)
      await waitUntil(() => client.output.stdout.includes("第三行"))
      expect(Bun.stripANSI(client.output.stdout)).toContain("remote-bird  Whisper received: café 🐦\n    second line\n    第三行\n")
      expect(client.output.stdout).not.toContain("\x1b[31m")
      await client.child.stdin.end()
      const result = await client.finished
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      expect(bird.allocations).toHaveLength(1)
      for (const request of bird.requests) {
        const path = new URL(request.url).pathname
        const privateOperation = path === `/inboxes/${inbox.id}/events` || request.method === "DELETE"
        expect(request.authorization).toBe(privateOperation ? `Bearer ${inbox.token}` : null)
        expect(request.url).not.toContain(inbox.token)
        expect(request.body).not.toContain(inbox.token)
      }
      expect(bird.requests.filter((request) => request.method === "DELETE")).toHaveLength(1)
      expect(result.stdout).not.toContain(inbox.token)
      expect(result.stderr).not.toContain(inbox.token)
      expect((await post(bird, inbox, "After EOF.")).status).toBe(404)
    } finally {
      await stopChat(client)
      await bird.close()
    }
  })

  test("drains every piped input line before EOF closes the inbox", async () => {
    const bird = fixture()
    const client = launchChat(bird.origin)
    try {
      await client.child.stdin.write("First piped message\nSecond piped message\n")
      await client.child.stdin.end()
      const result = await client.finished
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      const sent = bird.requests.filter((request) => new URL(request.url).pathname === "/ask")
      expect(sent.map((request) => request.body)).toEqual(["First piped message", "Second piped message"])
      expect(sent[0]?.replyTo).toBe(sent[1]?.replyTo)
      const inbox = bird.allocations[0]
      if (inbox === undefined) throw new Error("Missing hosted inbox")
      expect((await post(bird, inbox, "After EOF.")).status).toBe(404)
    } finally {
      await stopChat(client)
      await bird.close()
    }
  })

  test.each(["complete", "partial"] as const)("reconnects after a %s message without losing or duplicating replies", async (cut) => {
    const bird = fixture()
    const client = launchChat(bird.origin, `
      const nativeFetch = globalThis.fetch
      let interrupted = false
      globalThis.fetch = async (target, options) => {
        const response = await nativeFetch(target, options)
        const url = new URL(target instanceof Request ? target.url : String(target))
        if (interrupted || !/^\\/inboxes\\/[^/]+\\/events$/.test(url.pathname)) return response
        interrupted = true
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ""
        return new Response(new ReadableStream({
          async pull(controller) {
            for (;;) {
              const chunk = await reader.read()
              if (chunk.done) throw new Error("Stream ended before the planned cut")
              pending += decoder.decode(chunk.value, { stream: true })
              const line = pending.split("\\n").find(line => line.includes('"seq":1'))
              if (line === undefined || !pending.includes(line + "\\n")) continue
              controller.enqueue(new TextEncoder().encode(${cut === "complete" ? 'line + "\\n"' : "line.slice(0, Math.floor(line.length / 2))"}))
              await reader.cancel()
              controller.close()
              return
            }
          },
          cancel() { return reader.cancel() },
        }), { status: response.status, headers: response.headers })
      }
    `)
    try {
      await waitUntil(() => bird.allocations.length === 1 && client.output.stdout.includes("CHAT_READY"))
      const inbox = bird.allocations[0]
      if (inbox === undefined) throw new Error("Missing hosted inbox")
      expect((await post(bird, inbox, "FIRST_REPLAY_MESSAGE", { "x-from": "peer" })).status).toBe(202)
      expect((await post(bird, inbox, "SECOND_REPLAY_MESSAGE", { "x-from": "peer" })).status).toBe(202)
      await waitUntil(() => client.output.stdout.includes("SECOND_REPLAY_MESSAGE"))
      expect(client.output.stdout.split("FIRST_REPLAY_MESSAGE")).toHaveLength(2)
      expect(client.output.stdout.split("SECOND_REPLAY_MESSAGE")).toHaveLength(2)
      const reads = bird.requests.filter((request) => new URL(request.url).pathname === `/inboxes/${inbox.id}/events`)
      expect(reads.map((request) => new URL(request.url).searchParams.get("after"))).toEqual(["0", cut === "complete" ? "1" : "0"])
      expect(reads.map((request) => request.authorization)).toEqual([`Bearer ${inbox.token}`, `Bearer ${inbox.token}`])
      expect(bird.allocations).toHaveLength(1)
      await client.child.stdin.end()
      const result = await client.finished
      expect(result.code).toBe(0)
      expect(result.stderr).toContain("Reply stream disconnected; reconnecting")
      expect((await post(bird, inbox, "After EOF.")).status).toBe(404)
    } finally {
      await stopChat(client)
      await bird.close()
    }
  }, 10_000)

  test.each([
    [404, "Reply inbox expired or the server restarted"],
    [409, "Reply inbox buffer was exceeded"],
    [401, "inbox stream returned 401"],
  ] as const)("reports fatal inbox status %i without silently allocating a replacement", async (status, message) => {
    const bird = fixture({ respond: (request) => /^\/inboxes\/[^/]+\/events$/.test(new URL(request.url).pathname)
      ? new Response("Unavailable.", { status }) : null })
    const client = launchChat(bird.origin)
    try {
      const result = await client.finished
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(message)
      expect(bird.allocations).toHaveLength(1)
      expect(bird.requests.filter((request) => new URL(request.url).pathname.endsWith("/events")
        && new URL(request.url).pathname !== "/events")).toHaveLength(1)
      expect(bird.requests.filter((request) => request.method === "DELETE")).toHaveLength(1)
      const inbox = bird.allocations[0]
      if (inbox === undefined) throw new Error("Missing hosted inbox")
      expect((await post(bird, inbox, "After failure.")).status).toBe(404)
    } finally {
      await stopChat(client)
      await bird.close()
    }
  })

  test.each([
    ["malformed JSON", "not JSON\n", "Invalid reply stream"],
    ["missing sender", JSON.stringify({ type: "message", seq: 1, body: "MUST_NOT_DISPLAY" }) + "\n", "Invalid reply stream"],
    ["sequence gap", JSON.stringify({ type: "message", seq: 2, from: "bad", body: "MUST_NOT_DISPLAY" }) + "\n", "Reply stream skipped a message"],
  ] as const)("rejects %s instead of displaying unreliable replies", async (_name, data, message) => {
    const bird = fixture({ respond: (request) => /^\/inboxes\/[^/]+\/events$/.test(new URL(request.url).pathname)
      ? new Response(data) : null })
    const client = launchChat(bird.origin)
    try {
      const result = await client.finished
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(message)
      expect(result.stdout).not.toContain("MUST_NOT_DISPLAY")
      expect(bird.allocations).toHaveLength(1)
      expect(bird.requests.filter((request) => request.method === "DELETE")).toHaveLength(1)
    } finally {
      await stopChat(client)
      await bird.close()
    }
  })

  test.each(["old server", "invalid credentials", "non-JSON allocation"] as const)("explains an incompatible server: %s", async (scenario) => {
    const bird = fixture({ respond: (request) => {
      if (new URL(request.url).pathname !== "/inboxes") return null
      switch (scenario) {
        case "old server": return new Response("POST a plain-text message to /ask", { status: 404 })
        case "invalid credentials": return Response.json({ id: "../../not-an-inbox", token: crypto.randomUUID() })
        case "non-JSON allocation": return new Response("not JSON")
      }
    } })
    const client = launchChat(bird.origin)
    try {
      const result = await client.finished
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(scenario === "old server" ? "Update its installation and restart it" : "invalid reply inbox")
      expect(bird.requests).toHaveLength(1)
      const request = bird.requests[0]
      if (request === undefined) throw new Error("Missing allocation request")
      expect(new URL(request.url).pathname).toBe("/inboxes")
    } finally {
      await stopChat(client)
      await bird.close()
    }
  })

  test("does not retry a failed outgoing POST and revokes its inbox", async () => {
    const bird = fixture({ respond: (request) => new URL(request.url).pathname === "/ask"
      ? new Response("Not accepted.", { status: 503 }) : null })
    const client = launchChat(bird.origin)
    try {
      await waitUntil(() => client.output.stdout.includes("CHAT_READY"))
      await client.child.stdin.write("Send exactly once.\n")
      const result = await client.finished
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("503: Not accepted.")
      expect(bird.requests.filter((request) => new URL(request.url).pathname === "/ask")).toHaveLength(1)
      expect(bird.requests.filter((request) => request.method === "DELETE")).toHaveLength(1)
      const inbox = bird.allocations[0]
      if (inbox === undefined) throw new Error("Missing hosted inbox")
      expect((await post(bird, inbox, "After failure.")).status).toBe(404)
    } finally {
      await stopChat(client)
      await bird.close()
    }
  })

  test("keeps two same-named peers at different addresses", async () => {
    const first = "http://192.0.2.10:41001/ask"
    const second = "http://192.0.2.11:41001/ask"
    const bird = fixture({ events: [
      { kind: "received", callerId: "a", replyTo: first },
      { kind: "received", callerId: "a", replyTo: second },
      { type: "item.started", item: { type: "command_execution", command: "curl '" + first + "' --data-binary 'first machine'" } },
      { type: "item.started", item: { type: "command_execution", command: "curl '" + second + "' --data-binary 'second machine'" } },
    ] })
    const client = launchChat(bird.origin)
    try {
      await waitUntil(() => client.output.stdout.includes("second machine"))
      await client.child.stdin.end()
      const result = await client.finished
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("→ a  first machine\n")
      expect(result.stdout).toContain("→ a  second machine\n")
      expect(result.stdout).not.toContain(first)
      expect(result.stdout).not.toContain(second)
    } finally {
      await stopChat(client)
      await bird.close()
    }
  })
})

function fixture(options: {
  events?: object[]
  respond?: (request: Request) => Response | null
} = {}) {
  const inboxes = createInboxes()
  const allocations: Credentials[] = []
  const requests: RequestRecord[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      requests.push({
        url: request.url, method: request.method, authorization: request.headers.get("authorization"),
        from: request.headers.get("x-from"), replyTo: request.headers.get("x-reply-to"), body: await request.clone().text(),
      })
      const overridden = options.respond?.(request) ?? null
      if (overridden !== null) return overridden
      const path = new URL(request.url).pathname
      if (path === "/inboxes" || path.startsWith("/inboxes/")) {
        const response = await inboxes.handle(request)
        if (path === "/inboxes" && response.status === 201) allocations.push(await response.clone().json() as Credentials)
        return response
      }
      if (path === "/events") {
        const records = [
          { id: "bird", url: "http://10.0.0.5:3001/ask" },
          ...(options.events ?? []),
          { type: "item.completed", item: { type: "agent_message", text: "CHAT_READY" } },
        ]
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(encoder.encode(records.map((record) => JSON.stringify(record)).join("\n") + "\n")) },
        }))
      }
      return new Response(path === "/ask" ? "Accepted." : "Not found.", { status: path === "/ask" ? 202 : 404 })
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`, allocations, requests,
    async close() { inboxes.close(); await server.stop(true) },
  }
}

function post(bird: ReturnType<typeof fixture>, inbox: Credentials, body: string, headers: HeadersInit = {}): Promise<Response> {
  return fetch(`${bird.origin}/inboxes/${inbox.id}/ask`, { method: "POST", headers, body })
}

function launchChat(target: string, before = "") {
  const script = [
    "import { chat } from " + JSON.stringify(chatModule),
    'Bun.serve = () => { throw new Error("UNEXPECTED_LOCAL_LISTENER") }',
    before,
    "try {",
    "  await chat(" + JSON.stringify(target) + ")",
    "} catch (error) {",
    "  console.error(error instanceof Error ? error.message : String(error))",
    "  process.exitCode = 1",
    "}",
  ].join("\n")
  const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script], {
    env: { ...Bun.env, BIRDS_HOST: "old-callback.invalid", BIRDS_BIND: "192.0.2.1", HUMMINGBIRDS_CODEX: undefined },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const output = { stdout: "", stderr: "" }
  async function capture(stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr"): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of stream) output[key] += decoder.decode(chunk, { stream: true })
    output[key] += decoder.decode()
  }
  const finished = (async () => {
    const [code] = await Promise.all([child.exited, capture(child.stdout, "stdout"), capture(child.stderr, "stderr")])
    return { code, ...output }
  })()
  return { child, output, finished }
}

async function stopChat(client: ReturnType<typeof launchChat>): Promise<void> {
  if (client.child.exitCode === null) client.child.kill()
  await client.finished
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 4000
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Chat test condition was not met")
    await Bun.sleep(10)
  }
}
