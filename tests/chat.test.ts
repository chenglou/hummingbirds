import { describe, expect, test } from "bun:test"
import { resolve } from "path"
import type { Network } from "../src/network.ts"

type ChatOptions = Partial<Network> & { port?: number }

const chatModule = resolve(import.meta.dir, "../src/chat.ts")
const noNetwork = [
  'globalThis.fetch = () => { throw new Error("UNEXPECTED_FETCH") }',
  'Bun.serve = () => { throw new Error("UNEXPECTED_INBOX") }',
].join("\n")

describe("chat networking", () => {
  for (const options of [
    {},
    { host: "127.0.0.2", bind: "0.0.0.0" },
    { host: "::1", bind: "::" },
    { host: "localhost.", bind: "0.0.0.0" },
    { host: "::ffff:127.0.0.1", bind: "::" },
  ]) {
    test("rejects a remote destination with a loopback callback before network access: " + JSON.stringify(options), async () => {
      const client = launchChat("http://192.0.2.10:43210", options, noNetwork)
      try {
        const result = await client.finished
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("BIRDS_HOST")
        expect(result.stderr).toContain("reachable address")
        expect(result.stderr).not.toContain("UNEXPECTED_")
      } finally {
        await stopChat(client)
      }
    })
  }

  for (const port of [-1, 1.5, 65_536]) {
    test("rejects an invalid callback port before network access: " + port, async () => {
      const client = launchChat("http://127.0.0.1:43210", { port }, noNetwork)
      try {
        const result = await client.finished
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("Chat callback port")
        expect(result.stderr).not.toContain("UNEXPECTED_")
      } finally {
        await stopChat(client)
      }
    })
  }

  for (const scenario of [
    { host: "192.0.2.20", fixedPort: false },
    { host: "[2001:db8::20]", fixedPort: true },
  ]) {
    test("advertises the configured callback and receives a reply: " + scenario.host, async () => {
      let callbackPort = 0
      if (scenario.fixedPort) {
        const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
        if (reservation.port === undefined) throw new Error("Missing reserved callback port")
        callbackPort = reservation.port
        await reservation.stop(true)
      }
      const requests: { body: string; from: string | null; replyTo: string; requestId: string | null }[] = []
      const acknowledgments: { status: number; requestId: string | null }[] = []
      const requestId = crypto.randomUUID()
      let streamCancelled = false
      const bird = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
          switch (new URL(request.url).pathname) {
            case "/events":
              return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(JSON.stringify({
                    type: "item.completed",
                    item: { type: "agent_message", text: "CHAT_READY" },
                  }) + "\n"))
                },
                cancel() { streamCancelled = true },
              }))
            case "/ask": {
              const replyTo = request.headers.get("x-reply-to")
              if (replyTo === null) return new Response("Missing callback.", { status: 400 })
              requests.push({
                body: await request.text(),
                from: request.headers.get("x-from"),
                replyTo,
                requestId: request.headers.get("x-request"),
              })
              // The advertised documentation address is intentionally not routable:
              // deliver on its configured local bind while checking the literal header.
              const localCallback = new URL(replyTo)
              localCallback.hostname = "127.0.0.1"
              const reply = await fetch(localCallback, {
                method: "POST",
                headers: { "x-from": "remote-bird", "x-in-reply-to": requestId },
                body: "\x1b[31mReply received\x1b[0m\nsecond line",
              })
              acknowledgments.push({ status: reply.status, requestId: reply.headers.get("x-request") })
              await reply.text()
              return new Response("Accepted.", { status: 202, headers: { "x-request": requestId } })
            }
            default:
              return new Response("Not found.", { status: 404 })
          }
        },
      })
      const client = launchChat("http://127.0.0.1:" + bird.port, {
        host: scenario.host, bind: "127.0.0.1", port: callbackPort,
      })
      try {
        await waitUntil(() => client.output.stdout.includes("CHAT_READY"))
        await client.child.stdin.write("Hello remote bird.\n")
        await waitUntil(() => client.output.stdout.includes("Reply received"))
        expect(requests).toHaveLength(1)
        const received = requests[0]
        if (received === undefined) throw new Error("Missing chat request")
        const actualPort = new URL(received.replyTo).port
        expect(received.replyTo).toBe("http://" + scenario.host + ":" + actualPort + "/ask")
        expect(Number(actualPort)).toBeGreaterThan(0)
        if (scenario.fixedPort) expect(Number(actualPort)).toBe(callbackPort)
        expect(received.body).toBe("Hello remote bird.")
        expect(received.from).toBe("human")
        expect(received.requestId).toBeNull()
        await waitUntil(() => acknowledgments.length === 1)
        expect(acknowledgments).toEqual([{ status: 202, requestId }])
        expect(Bun.stripANSI(client.output.stdout)).toContain("remote-bird  Reply received\n    second line\n")
        await client.child.stdin.end()
        const result = await client.finished
        expect(result.code).toBe(0)
        expect(result.stderr).toBe("")
        await waitUntil(() => streamCancelled)
      } finally {
        await stopChat(client)
        await bird.stop(true)
      }
    })
  }

  test("keeps two same-named peers at different addresses", async () => {
    const first = "http://192.0.2.10:41001/ask"
    const second = "http://192.0.2.11:41001/ask"
    const records = [
      { kind: "received", callerId: "a", replyTo: first },
      { kind: "received", callerId: "a", replyTo: second },
      { type: "item.started", item: { type: "command_execution", command: "curl '" + first + "' --data-binary 'first machine'" } },
      { type: "item.started", item: { type: "command_execution", command: "curl '" + second + "' --data-binary 'second machine'" } },
    ]
    const bird = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(records.map((record) => JSON.stringify(record)).join("\n") + "\n"),
    })
    const client = launchChat("http://127.0.0.1:" + bird.port)
    try {
      const result = await client.finished
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("→ a  first machine\n")
      expect(result.stdout).toContain("→ a  second machine\n")
      expect(result.stdout).not.toContain(first)
      expect(result.stdout).not.toContain(second)
    } finally {
      await stopChat(client)
      await bird.stop(true)
    }
  })

  test("aborts the event stream when the fixed callback port is occupied", async () => {
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    if (occupied.port === undefined) throw new Error("Missing occupied port")
    let streamCancelled = false
    const bird = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 0,
      fetch: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("{}\n")) },
        cancel() { streamCancelled = true },
      })),
    })
    const client = launchChat("http://127.0.0.1:" + bird.port, { port: occupied.port })
    try {
      const result = await client.finished
      expect(result.code).toBe(1)
      expect(result.stderr).not.toBe("")
      await waitUntil(() => streamCancelled)
    } finally {
      await stopChat(client)
      await bird.stop(true)
      await occupied.stop(true)
    }
  })
})

function launchChat(target: string, options: ChatOptions = {}, before = "") {
  const script = [
    "import { chat } from " + JSON.stringify(chatModule),
    before,
    "try {",
    "  await chat(" + JSON.stringify(target) + ", " + JSON.stringify(options) + ")",
    "} catch (error) {",
    "  console.error(error instanceof Error ? error.message : String(error))",
    "  process.exitCode = 1",
    "}",
  ].join("\n")
  const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script], {
    env: {
      ...Bun.env,
      BIRDS_HOST: undefined,
      BIRDS_BIND: undefined,
      BIRDS_CHAT_PORT: undefined,
      HUMMINGBIRDS_CODEX: undefined,
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const output = { stdout: "", stderr: "" }
  async function capture(stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr"): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of stream) output[key] += decoder.decode(chunk, { stream: true })
    output[key] += decoder.decode()
  }
  const finished = (async () => {
    const [code] = await Promise.all([
      child.exited, capture(child.stdout, "stdout"), capture(child.stderr, "stderr"),
    ])
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
