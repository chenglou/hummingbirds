import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createInboxes } from "../src/inbox.ts"

type Inboxes = ReturnType<typeof createInboxes>
type Credentials = { id: string; token: string }
const active: Inboxes[] = []

afterEach(() => {
  for (const inboxes of active) inboxes.close()
  active.length = 0
  mock.restore()
})

describe("hosted inboxes", () => {
  test("isolates messages and credentials between independently created inboxes", async () => {
    const inboxes = setup()
    const first = await create(inboxes)
    const second = await create(inboxes)
    expect(first.id).not.toBe(second.id)
    expect(first.token).not.toBe(second.token)
    expect(first.token).not.toBe(first.id)
    const firstReader = await reader(inboxes, first)
    const secondReader = await reader(inboxes, second)
    const text = "  hello 🌱\n第二行\n\nlast line\n"
    const replyId = crypto.randomUUID()
    const sent = await post(inboxes, first, text, { "x-from": "a", "x-in-reply-to": replyId })
    expect(sent.status).toBe(202)
    expect(sent.headers.get("x-request")).toBe(replyId)
    expect(await sent.text()).toBe("Accepted by inbox.")
    expect(await event(firstReader)).toEqual({
      type: "message", seq: 1, from: "a", body: text, requestId: replyId, inReplyTo: replyId,
    })
    const other = await post(inboxes, second, "only the second inbox")
    expect(await event(secondReader)).toEqual({
      type: "message", seq: 1, from: "unknown", body: "only the second inbox",
      requestId: other.headers.get("x-request"), inReplyTo: null,
    })
    await firstReader.cancel()
    await secondReader.cancel()
  })

  test("the write address does not authorize reading or deleting", async () => {
    const inboxes = setup()
    const first = await create(inboxes)
    const second = await create(inboxes)
    for (const token of [null, "wrong-token", first.id, second.token]) {
      const headers = token === null ? {} : { authorization: `Bearer ${token}` }
      for (const path of ["/events", ""]) {
        const response = await inboxes.handle(new Request(url(first, path), {
          method: path === "" ? "DELETE" : "GET", headers,
        }))
        expect(response.status).toBe(401)
      }
    }
    expect((await post(inboxes, first, "A sender needs only the write address.")).status).toBe(202)
    const stream = await reader(inboxes, first)
    expect(await event(stream)).toMatchObject({ body: "A sender needs only the write address." })
    await stream.cancel()
  })

  test("validates ordinary request/reply headers and nonempty plain-text bodies", async () => {
    const inboxes = setup()
    const inbox = await create(inboxes)
    const requestId = crypto.randomUUID().toUpperCase()
    for (const headers of [
      { "x-request": "not-a-uuid" },
      { "x-in-reply-to": "not-a-uuid" },
      { "x-request": requestId, "x-in-reply-to": requestId },
      { "x-request": "" },
    ]) {
      expect((await post(inboxes, inbox, "hello", headers)).status).toBe(400)
    }
    for (const body of ["", " \n\t "]) {
      expect((await post(inboxes, inbox, body)).status).toBe(400)
    }
    const valid = await post(inboxes, inbox, "new fact", {
      "x-request": requestId,
      "x-from": "ordinary-peer",
      "x-reply-to": "http://peer.example:3001/ask",
      "x-route": '["http://peer.example:3001/ask"]',
    })
    expect(valid.status).toBe(202)
    expect(valid.headers.get("x-request")).toBe(requestId)
    const stream = await reader(inboxes, inbox)
    expect(await event(stream)).toEqual({
      type: "message", seq: 1, from: "ordinary-peer", body: "new fact", requestId, inReplyTo: null,
    })
    await stream.cancel()
  })

  test("replays only unseen messages after a reconnect and resumes live delivery", async () => {
    const inboxes = setup()
    const inbox = await create(inboxes)
    for (const body of ["one", "two", "three"]) await post(inboxes, inbox, body)
    const first = await reader(inboxes, inbox, 1)
    expect(await event(first)).toMatchObject({ seq: 2, body: "two" })
    expect(await event(first)).toMatchObject({ seq: 3, body: "three" })
    await post(inboxes, inbox, "four")
    expect(await event(first)).toMatchObject({ seq: 4, body: "four" })
    await first.cancel()
    await post(inboxes, inbox, "five")
    const second = await reader(inboxes, inbox, 4)
    expect(await event(second)).toMatchObject({ seq: 5, body: "five" })
    await second.cancel()
  })

  test("rejects malformed, unsafe, and future cursors before replacing a reader", async () => {
    const inboxes = setup()
    const inbox = await create(inboxes)
    const live = await reader(inboxes, inbox)
    for (const after of ["-1", "1.5", "", "NaN", "01", "9007199254740992", "1"]) {
      const response = await inboxes.handle(new Request(url(inbox, `/events?after=${after}`), {
        headers: auth(inbox),
      }))
      expect(response.status).toBe(400)
    }
    await post(inboxes, inbox, "still connected")
    expect(await event(live)).toMatchObject({ seq: 1, body: "still connected" })
    await live.cancel()
  })

  test("caps retained entry count and rejects a replay gap explicitly", async () => {
    const inboxes = setup()
    const inbox = await create(inboxes)
    for (let index = 1; index <= 101; index += 1) await post(inboxes, inbox, `message ${index}`)
    const gap = await inboxes.handle(new Request(url(inbox, "/events?after=0"), { headers: auth(inbox) }))
    expect(gap.status).toBe(409)
    expect(await gap.text()).toContain("history")
    const stream = await reader(inboxes, inbox, 1)
    expect(await event(stream)).toMatchObject({ seq: 2, body: "message 2" })
    await stream.cancel()
    const last = await reader(inboxes, inbox, 100)
    expect(await event(last)).toMatchObject({ seq: 101, body: "message 101" })
    await last.cancel()
  })

  test("also bounds retained bytes, message bytes, and untrusted metadata", async () => {
    const inboxes = setup()
    const inbox = await create(inboxes)
    for (const body of ["x".repeat(65_537), "🌱".repeat(16_385)]) {
      expect((await post(inboxes, inbox, body)).status).toBe(413)
    }
    expect((await post(inboxes, inbox, "tiny body", { "x-from": "x".repeat(65_537) })).status).toBe(413)
    const body = "x".repeat(60_000)
    for (let index = 0; index < 20; index += 1) expect((await post(inboxes, inbox, body)).status).toBe(202)
    const gap = await inboxes.handle(new Request(url(inbox, "/events?after=0"), { headers: auth(inbox) }))
    expect(gap.status).toBe(409)
    const stream = await reader(inboxes, inbox, 19)
    expect(await event(stream)).toMatchObject({ seq: 20, body })
    await stream.cancel()
  })

  test("cancels oversized streaming bodies without retaining their prefix", async () => {
    const inboxes = setup()
    const inbox = await create(inboxes)
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(40_000).fill(120)) },
      cancel() { canceled = true },
    })
    const response = await inboxes.handle(new Request(url(inbox, "/ask"), { method: "POST", body }))
    expect(response.status).toBe(413)
    expect(canceled).toBe(true)
    await post(inboxes, inbox, "first actual message")
    const stream = await reader(inboxes, inbox)
    expect(await event(stream)).toMatchObject({ seq: 1 })
    await stream.cancel()
  })

  test("does not grow an unread stream without bound", async () => {
    const inboxes = setup()
    const inbox = await create(inboxes)
    const response = await inboxes.handle(new Request(url(inbox, "/events"), { headers: auth(inbox) }))
    if (response.body === null) throw new Error("Missing inbox stream")
    for (let index = 0; index < 102; index += 1) await post(inboxes, inbox, "unread")
    const stream = response.body.getReader()
    let failure: unknown
    try {
      await stream.read()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("slow reader")
    const retry = await inboxes.handle(new Request(url(inbox, "/events?after=0"), { headers: auth(inbox) }))
    expect(retry.status).toBe(409)
  })

  test("replacement closes only the previous reader, and DELETE revokes the inbox", async () => {
    const heartbeats = spyOn(globalThis, "setInterval")
    const clearHeartbeat = spyOn(globalThis, "clearInterval")
    const inboxes = setup()
    const inbox = await create(inboxes)
    const first = await reader(inboxes, inbox)
    const second = await reader(inboxes, inbox)
    expect(heartbeats).toHaveBeenCalledTimes(2)
    expect(heartbeats.mock.calls[0]?.[1]).toBe(15_000)
    expect(clearHeartbeat).toHaveBeenCalledTimes(1)
    expect(await event(first)).toEqual({ type: "closed" })
    expect((await first.read()).done).toBe(true)
    await first.cancel()
    await post(inboxes, inbox, "new reader remains live")
    expect(await event(second)).toMatchObject({ body: "new reader remains live" })
    const removed = await inboxes.handle(new Request(url(inbox), { method: "DELETE", headers: auth(inbox) }))
    expect(removed.status).toBe(204)
    expect(clearHeartbeat).toHaveBeenCalledTimes(2)
    expect(await event(second)).toEqual({ type: "closed" })
    expect((await second.read()).done).toBe(true)
    expect((await post(inboxes, inbox, "too late")).status).toBe(404)
    expect((await inboxes.handle(new Request(url(inbox, "/events"), { headers: auth(inbox) }))).status).toBe(404)
  })

  test("reclaims disconnected inboxes after five minutes but keeps a live reader", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000_000)
    const inboxes = setup()
    const abandoned = await create(inboxes)
    const connected = await create(inboxes)
    const stream = await reader(inboxes, connected)
    clock.mockReturnValue(1_300_000)
    expect((await post(inboxes, abandoned, "expired")).status).toBe(404)
    expect((await post(inboxes, connected, "still live")).status).toBe(202)
    expect(await event(stream)).toMatchObject({ body: "still live" })
    await stream.cancel()
    clock.mockReturnValue(1_599_999)
    expect((await post(inboxes, connected, "queued while disconnected")).status).toBe(202)
    clock.mockReturnValue(1_600_000)
    expect((await post(inboxes, connected, "does not extend its abandoned lifetime")).status).toBe(404)
  })

  test("caps inbox count and makes capacity available on deletion and expiry", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000_000)
    const inboxes = setup()
    const inbox = await create(inboxes)
    for (let index = 1; index < 32; index += 1) await create(inboxes)
    expect((await inboxes.handle(new Request("http://birds/inboxes", { method: "POST" }))).status).toBe(503)
    expect((await inboxes.handle(new Request(url(inbox), { method: "DELETE", headers: auth(inbox) }))).status).toBe(204)
    await create(inboxes)
    clock.mockReturnValue(1_300_000)
    await create(inboxes)
  })

  test("deletion or shutdown while receiving a body cannot acknowledge a lost message", async () => {
    for (const shutdown of [false, true]) {
      const inboxes = setup()
      const inbox = await create(inboxes)
      let controller: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
      const pending = inboxes.handle(new Request(url(inbox, "/ask"), { method: "POST", body }))
      if (shutdown) inboxes.close()
      else await inboxes.handle(new Request(url(inbox), { method: "DELETE", headers: auth(inbox) }))
      controller!.enqueue(new TextEncoder().encode("too late"))
      controller!.close()
      expect((await pending).status).toBe(404)
    }
  })

  test("shutdown closes all readers and accepts no further inboxes", async () => {
    const inboxes = setup()
    const first = await reader(inboxes, await create(inboxes))
    const second = await reader(inboxes, await create(inboxes))
    inboxes.close()
    expect(await event(first)).toEqual({ type: "closed" })
    expect(await event(second)).toEqual({ type: "closed" })
    expect((await first.read()).done).toBe(true)
    expect((await second.read()).done).toBe(true)
    expect((await inboxes.handle(new Request("http://birds/inboxes", { method: "POST" }))).status).toBe(503)
    inboxes.close()
  })
})

function setup(): Inboxes {
  const inboxes = createInboxes()
  active.push(inboxes)
  return inboxes
}

async function create(inboxes: Inboxes): Promise<Credentials> {
  const response = await inboxes.handle(new Request("http://birds/inboxes", { method: "POST" }))
  expect(response.status).toBe(201)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const value: unknown = await response.json()
  if (typeof value !== "object" || value === null
    || !("id" in value) || typeof value.id !== "string"
    || !("token" in value) || typeof value.token !== "string") throw new Error("Invalid inbox credentials")
  expect(value.id).toMatch(/^[a-f0-9-]{36}$/)
  expect(value.token).toMatch(/^[a-f0-9-]{36}$/)
  return { id: value.id, token: value.token }
}

function url(inbox: Credentials, path = ""): string {
  return `http://birds/inboxes/${inbox.id}${path}`
}

function auth(inbox: Credentials): Record<string, string> {
  return { authorization: `Bearer ${inbox.token}` }
}

function post(inboxes: Inboxes, inbox: Credentials, body: string, headers: HeadersInit = {}): Promise<Response> {
  return inboxes.handle(new Request(url(inbox, "/ask"), { method: "POST", headers, body }))
}

async function reader(inboxes: Inboxes, inbox: Credentials, after = 0): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await inboxes.handle(new Request(url(inbox, `/events?after=${after}`), { headers: auth(inbox) }))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8")
  if (response.body === null) throw new Error("Missing inbox stream")
  const stream = response.body.getReader()
  const first = await stream.read()
  expect(new TextDecoder().decode(first.value)).toBe("\n")
  return stream
}

async function event(stream: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  while (true) {
    const next = await stream.read()
    if (next.done) throw new Error("Unexpected end of inbox stream")
    const line = new TextDecoder().decode(next.value)
    if (line.trim() !== "") return JSON.parse(line)
  }
}
