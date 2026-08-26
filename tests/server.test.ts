import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { basename, dirname, join, resolve } from "path"

type Bird = {
  directory: string
  id: string
  process: Bun.Subprocess<"ignore", "pipe", "pipe">
  url: string
}

type Event = {
  callerId: string
  inReplyTo: string | null
  invocationId: string
  path: string[]
  replyTo: string | null
  requestId: string
} & (
  | { kind: "received"; question: string }
  | { kind: "rejected"; error: string }
  | { kind: "failed"; error: string }
  | { kind: "started"; threadId: string | null }
  | { kind: "completed"; threadId: string }
)

type Message = { body: string; from: string; inReplyTo: string | null; request: string | null }

const fakeCodex = resolve("tests/fake-codex.ts")
const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("Hummingbirds", () => {
  test("starts a bird, streams its conversation, and resumes after a restart", async () => {
    const directory = join(await makeTemporaryDirectory(), "bird")
    let bird: Bird | null = null
    let stream: ReadableStreamDefaultReader<Uint8Array> | null = null
    let mirror: ReadableStreamDefaultReader<Uint8Array> | null = null

    try {
      bird = await startBird(directory, { PATH: dirname(process.execPath) })
      const originalBird = bird
      const agentsPath = join(directory, "bird", "workspace", "AGENTS.md")
      const agents = await readFile(agentsPath, "utf8")
      expect(agents).toContain(`Your ID is bird, and your address is ${bird.url}.`)
      expect(agents).not.toContain("[peers]")
      expect(agents).not.toContain("parent-invocation-id")

      const eventResponse = await fetch(new URL("/events", bird.url))
      expect(eventResponse.headers.get("content-type")).toContain("application/x-ndjson")
      if (eventResponse.body === null) throw new Error("Bird did not provide an event stream")
      stream = eventResponse.body.getReader()
      let streamed = new TextDecoder().decode((await stream.read()).value)
      expect(JSON.parse(streamed.trim())).toEqual({
        id: "bird",
        pid: bird.process.pid,
        url: bird.url,
      })
      const mirrorResponse = await fetch(new URL("/events", bird.url))
      if (mirrorResponse.body === null) throw new Error("Bird did not provide a second event stream")
      mirror = mirrorResponse.body.getReader()
      let mirrored = new TextDecoder().decode((await mirror.read()).value)
      expect(mirrored).toBe(streamed)
      expect((await fetch(new URL("/events", bird.url), { method: "POST" })).status).toBe(405)

      const first = await send(bird, "Remember Ben likes hiking.", opaque("q-first"))
      expect([first.status, await first.text()]).toEqual([202, "Accepted by bird."])
      await waitUntil(async () => {
        return (await events(originalBird)).some((event) => event.kind === "completed")
      })
      while (!streamed.includes('"kind":"completed"')) {
        const chunk = await stream.read()
        if (chunk.done) throw new Error("Bird closed its event stream")
        streamed += new TextDecoder().decode(chunk.value)
      }
      while (!mirrored.includes('"kind":"completed"')) {
        const chunk = await mirror.read()
        if (chunk.done) throw new Error("Bird closed its second event stream")
        mirrored += new TextDecoder().decode(chunk.value)
      }
      expect(mirrored).toBe(streamed)
      expect(streamed).toContain('"kind":"received"')
      expect(streamed).toContain('"type":"thread.started"')
      expect(streamed).not.toContain("\u001b[")
      expect(streamed).not.toContain('"parentInvocationId"')

      await mirror.cancel()
      mirror = null
      const streamRequest = opaque("q-stream")
      expect((await send(bird, "One subscriber remains.", streamRequest)).status).toBe(202)
      while ((streamed.match(/"kind":"completed"/g) ?? []).length < 2) {
        const chunk = await stream.read()
        if (chunk.done) throw new Error("Bird closed its surviving event stream")
        streamed += new TextDecoder().decode(chunk.value)
      }
      expect(streamed).toContain(`"requestId":"${streamRequest}"`)
      await stream.cancel()
      stream = null

      const threadIdPath = join(directory, "bird", "thread-id")
      const threadId = await readFile(threadIdPath, "utf8")

      const port = Number(new URL(bird.url).port)
      await stopBird(bird)
      const output = await readRemainingOutput(bird.process.stdout)
      expect(output).toContain('"kind":"received"')
      expect(output).toContain('"type":"thread.started"')
      expect(output).toContain("Handled by bird: Remember Ben likes hiking.")
      expect(output).not.toContain('"nodeId":')
      expect(output).not.toContain("\u001b[")

      bird = await startBird(directory, {}, port)
      const restartedBird = bird
      expect(await readFile(agentsPath, "utf8")).toBe(agents)
      expect((await send(bird, "And Ben likes camping.", opaque("q-second"))).status).toBe(202)
      await waitUntil(async () => {
        return (await events(restartedBird)).filter((event) => event.kind === "completed").length === 3
      })
      expect(await readFile(threadIdPath, "utf8")).toBe(threadId)
    } finally {
      if (mirror !== null) await mirror.cancel()
      if (stream !== null) await stream.cancel()
      if (bird !== null) await stopBird(bird)
    }
  }, 15_000)

  test("keeps the foreground server noninteractive even in a terminal", async () => {
    const directory = join(await makeTemporaryDirectory(), "foreground")
    await mkdir(directory, { recursive: true })
    const decoder = new TextDecoder()
    let output = ""
    const child = Bun.spawn([process.execPath, "run", resolve("src/server.ts")], {
      cwd: directory,
      env: {
        ...Bun.env,
        HUMMINGBIRDS_CODEX: fakeCodex,
        HUMMINGBIRDS_DIRECTORY: join(directory, "bird"),
        HUMMINGBIRDS_NODE_ID: "foreground",
        HUMMINGBIRDS_PORT: "0",
      },
      terminal: {
        cols: 120,
        rows: 24,
        data(_terminal, chunk) {
          output += decoder.decode(chunk, { stream: true })
        },
      },
    })
    const terminal = child.terminal
    if (terminal === undefined) throw new Error("Server did not start in a terminal")

    try {
      await waitUntil(async () => output.includes('"id":"foreground"'))
      const startup = JSON.parse(output.split("\n")[0] ?? "") as { url: string }
      terminal.write("This is not a message.\n")
      const response = await fetch(startup.url, { method: "POST", body: "This is a message." })
      expect(response.status).toBe(202)
      await waitUntil(async () => {
        return (await events({ directory })).some((event) => event.kind === "completed")
      })
      expect(
        (await events({ directory }))
          .filter((event) => event.kind === "received")
          .map((event) => event.question),
      ).toEqual(["This is a message."])
      expect(output).not.toContain(" You ")
      expect(output).not.toContain("\u001b[")
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      terminal.close()
    }
  }, 10_000)

  test("attaches an independent terminal while HTTP uses the same conversation", async () => {
    const directory = join(await makeTemporaryDirectory(), "interactive")
    const peer = startInbox()
    const bird = await startBird(directory, {
      HUMMINGBIRDS_FAKE_DELAY_MS: "100",
      HUMMINGBIRDS_PEERS: `- b at ${peer.url}`,
    })
    let output = ""
    const child = startChat(directory, new URL(bird.url).port, (chunk) => {
      output += chunk
    })
    const terminal = child.terminal
    if (terminal === undefined) throw new Error("Chat did not start in a terminal")

    try {
      await waitUntil(async () => Bun.stripANSI(output).includes(" You "))

      terminal.write("\nFirst typed message\n  \n")
      await waitUntil(async () => {
        return (await events(bird)).some(
          (event) => event.kind === "received" && event.question === "First typed message",
        )
      })
      const humanAddress = (await events(bird)).find(
        (event) => event.kind === "received" && event.question === "First typed message",
      )?.replyTo
      if (humanAddress === undefined || humanAddress === null) {
        throw new Error("Typed message did not provide a return address")
      }
      const humanUrl = new URL(humanAddress)
      expect([humanUrl.hostname, humanUrl.pathname]).toEqual(["127.0.0.1", "/ask"])
      expect(humanUrl.port).not.toBe(new URL(bird.url).port)
      await waitUntil(async () => {
        return (Bun.stripANSI(output).split(/[\r\n]/).at(-1) ?? "").includes(" You ")
      })

      const httpMessage = "Ordinary HTTP message\n\u001b[31mSecond line\u001b[0m"
      const response = await fetch(bird.url, {
        method: "POST",
        headers: {
          "x-from": "peer-a",
          "x-request": opaque("q-http"),
        },
        body: httpMessage,
      })
      expect(response.status).toBe(202)
      terminal.write("Second typed message\n\n")

      await waitUntil(async () => {
        return (await events(bird)).filter((event) => event.kind === "completed").length === 3
      })
      const trace = await events(bird)
      const incoming = trace.filter((event) => event.kind === "received")
      expect(incoming.map((event) => event.question)).toEqual([
        "First typed message",
        httpMessage,
        "Second typed message",
      ])
      expect(incoming.map((event) => event.callerId)).toEqual(["human", "peer-a", "human"])
      expect(incoming.map((event) => event.replyTo)).toEqual([humanAddress, null, humanAddress])

      const turns = trace.filter((event) => event.kind === "started" || event.kind === "completed")
      expect(turns.map((event) => event.kind)).toEqual([
        "started",
        "completed",
        "started",
        "completed",
        "started",
        "completed",
      ])
      const threadId = await readFile(join(directory, "bird", "thread-id"), "utf8")
      expect(turns.filter((event) => event.kind === "started").map((event) => event.threadId)).toEqual(
        [null, threadId, threadId],
      )
      expect(
        turns.filter((event) => event.kind === "completed").every((event) => !("answer" in event)),
      ).toBe(true)

      await waitUntil(async () => output.includes("Handled by interactive: Second typed message"))
      expect(output).not.toContain('{"')
      const coloredOutput = output.replaceAll("\u001b", "ESC")
      expect(coloredOutput).not.toContain("ESC[90m")
      const promptColors = [...coloredOutput.matchAll(/ESC\[30;(10[1-6])m You ESC\[0m/g)].map(
        (match) => match[1],
      )
      expect(promptColors.length).toBeGreaterThanOrEqual(2)
      expect(promptColors.every((color) => color === promptColors[0])).toBe(true)
      expect(coloredOutput).toMatch(
        /ESC\[30;10[1-6]m interactive ESC\[0m Handled by interactive: First typed message/,
      )
      expect(coloredOutput).not.toMatch(/ESC\[30;10[1-6]m H ESC\[0m/)
      expect(coloredOutput).not.toMatch(/ESC\[30;10[1-6]m (P|peer-a) ESC\[0m/)
      expect(coloredOutput).not.toMatch(/ESC\[30;10[1-6]m interactive \(self\) ESC\[0m/)
      const plainOutput = Bun.stripANSI(output)
      expect(plainOutput).toContain(" You ")
      expect(plainOutput).toMatch(/← peer-a  Ordinary HTTP message\r?\n {4}Second line\r?\n/)
      expect(plainOutput).toMatch(
        /interactive: Handled by interactive: Ordinary HTTP message\r?\n {4}Second line\r?\n/,
      )
      expect(plainOutput).not.toContain("→ human")
      expect(output).not.toContain("\u001b[31m")
      expect(await readFile(join(directory, "bird", "events.jsonl"), "utf8")).not.toContain(
        "\u001b[",
      )
      expect(await readFile(join(directory, "bird", "events.jsonl"), "utf8")).not.toContain(
        '"kind":"delivered"',
      )

      const peerMessage = "What does b know about Nacre-A's path C:\\harbor?"
      const unknownPeer = `→ ${peer.url}  ${peerMessage}`
      terminal.write(`${peerMessage}\n`)
      await waitUntil(async () => {
        return (
          peer.messages.length === 1 &&
          output.includes(unknownPeer) &&
          (await events(bird)).filter((event) => event.kind === "completed").length === 4
        )
      })
      expect(peer.messages[0]?.body).toBe(peerMessage)
      expect(peer.messages[0]?.request).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      expect(peer.messages[0]?.inReplyTo).toBeNull()
      expect(output.split(unknownPeer)).toHaveLength(2)

      const peerQuestion = (await events(bird)).find(
        (event) => event.kind === "received" && event.question === peerMessage,
      )
      if (peerQuestion === undefined) throw new Error("Missing peer question")
      expect(peer.messages[0]?.request).toBe(peerQuestion.requestId)
      const peerReply = await fetch(bird.url, {
        method: "POST",
        headers: {
          "x-from": "b",
          "x-in-reply-to": peerQuestion.requestId,
          "x-route": JSON.stringify(["interactive", "b"]),
          "x-reply-to": peer.url,
        },
        body: "B knows Nacre-A.",
      })
      expect([peerReply.status, await peerReply.text()]).toEqual([202, "Accepted by interactive."])
      await waitUntil(async () => {
        return (
          (await events(bird)).some(
            (event) => event.kind === "completed" && event.inReplyTo === peerQuestion.requestId,
          ) &&
          Bun.stripANSI(output).includes("interactive  B knows Nacre-A.")
        )
      })
      expect(output).not.toContain(peerQuestion.requestId)
      expect(output.replaceAll("\u001b", "ESC")).toMatch(
        /ESC\[30;10[1-6]m interactive ESC\[0m B knows Nacre-A\./,
      )
      expect(Bun.stripANSI(output)).not.toContain(`→ ${humanAddress}`)

      const knownPeerMessage = "What does b know about Nacre-B?"
      terminal.write(`${knownPeerMessage}\n`)
      await waitUntil(async () => {
        return peer.messages.length === 2 && output.includes(`→ b  ${knownPeerMessage}`)
      })

      for (const headers of [
        { "x-request": "create-child" },
        { "x-in-reply-to": "create-child" },
        { "x-request": opaque("invalid-inbox"), "x-in-reply-to": opaque("invalid-inbox") },
      ]) {
        const invalid = await fetch(humanAddress, {
          method: "POST",
          headers,
          body: "This invalid message must not appear.",
        })
        expect(invalid.status).toBe(400)
      }
      expect(output).not.toContain("This invalid message must not appear.")

      const emptyHumanDelivery = await fetch(humanAddress, {
        method: "POST",
        headers: { "x-request": opaque("q-empty-human") },
        body: " \n",
      })
      expect([emptyHumanDelivery.status, await emptyHumanDelivery.text()]).toEqual([
        400,
        "Empty message.",
      ])
      expect(output).not.toContain('"requestId":"q-empty-human"')
      expect(output).not.toContain('{"')
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      terminal.close()
      await stopBird(bird)
      peer.stop()
    }
  }, 15_000)

  test("attaches by current port, explicit port, host, or HTTP origin", async () => {
    const bird = await startBird(join(await makeTemporaryDirectory(), "destinations"))
    const port = new URL(bird.url).port
    const destinations = [undefined, port, `localhost:${port}`, `http://127.0.0.1:${port}`]

    try {
      for (const [index, destination] of destinations.entries()) {
        let output = ""
        const child = startChat(
          bird.directory,
          destination,
          (chunk) => {
            output += chunk
          },
          { HUMMINGBIRDS_PORT: port },
        )
        const terminal = child.terminal
        if (terminal === undefined) throw new Error("Chat did not start in a terminal")

        try {
          await waitUntil(async () => Bun.stripANSI(output).includes(" You "))
          const message = `Destination ${index}`
          terminal.write(`${message}\n`)
          await waitUntil(async () => {
            return Bun.stripANSI(output).includes(`destinations  Handled by destinations: ${message}`)
          })
        } finally {
          if (child.exitCode === null) child.kill()
          await child.exited
          terminal.close()
        }
      }

      const invalid = Bun.spawn([process.execPath, "run", resolve("src/chat.ts"), bird.url], {
        cwd: bird.directory,
        stderr: "pipe",
        stdout: "ignore",
      })
      expect(await invalid.exited).not.toBe(0)
      expect(await new Response(invalid.stderr).text()).toContain("without /ask or /events")
    } finally {
      await stopBird(bird)
    }
  }, 15_000)

  test("independent birds pass replies, learn a peer, and remember it after restarting", async () => {
    const root = await makeTemporaryDirectory()
    const birds: Bird[] = []

    try {
      const c = await startBird(join(root, "c"), {
        HUMMINGBIRDS_SEED:
          "- Tideglass trial Nacre-A records the exact harbor phrase “Amber Tern-417.”\n" +
          "- Saltclock trial Nacre-B records the exact harbor phrase “Violet Shoal-862.”",
      })
      birds.push(c)
      const b = await startBird(join(root, "b"), {
        HUMMINGBIRDS_PEERS: `- c at ${c.url}`,
      })
      birds.push(b)
      let a = await startBird(join(root, "a"), {
        HUMMINGBIRDS_PEERS: `- b at ${b.url}`,
      })
      birds.push(a)

      const trainingRequest = opaque("q-train")
      const training = await send(a, "What harbor phrase belongs to Nacre-A?", trainingRequest)
      expect(training.status).toBe(202)
      await waitUntil(async () => {
        return (await events(a)).some(
          (event) => event.kind === "completed" && event.inReplyTo === trainingRequest,
        )
      })
      const trainingReply = (await events(a))
        .filter((event) => event.kind === "received")
        .find((event) => event.inReplyTo === trainingRequest)
      expect(trainingReply?.question).toBe(`Amber Tern-417.\n\nContributors: c at ${c.url}`)
      expect(received(await events(a), trainingRequest)).toEqual([
        ["human", null, null, []],
        ["b", b.url, trainingRequest, ["a", "b"]],
      ])
      expect(received(await events(b), trainingRequest)).toEqual([
        ["a", a.url, null, ["a"]],
        ["c", c.url, trainingRequest, ["a", "b", "c"]],
      ])
      expect(received(await events(c), trainingRequest)).toEqual([["b", b.url, null, ["a", "b"]]])

      const firstThreadId = await readFile(join(a.directory, "bird", "thread-id"), "utf8")
      const port = Number(new URL(a.url).port)
      await stopBird(a)
      a = await startBird(a.directory, {}, port)
      birds[2] = a

      const probeRequest = opaque("q-probe")
      const probe = await send(a, "What harbor phrase belongs to Nacre-B?", probeRequest)
      expect(probe.status).toBe(202)
      await waitUntil(async () => {
        return (await events(a)).some(
          (event) => event.kind === "completed" && event.inReplyTo === probeRequest,
        )
      })
      const probeReply = (await events(a))
        .filter((event) => event.kind === "received")
        .find((event) => event.inReplyTo === probeRequest)
      expect(probeReply?.question).toBe(`Violet Shoal-862.\n\nContributors: c at ${c.url}`)
      expect(received(await events(a), probeRequest)).toEqual([
        ["human", null, null, []],
        ["c", c.url, probeRequest, ["a", "c"]],
      ])
      expect(received(await events(b), probeRequest)).toEqual([])
      expect(received(await events(c), probeRequest)).toEqual([["a", a.url, null, ["a"]]])
      expect(await readFile(join(a.directory, "bird", "thread-id"), "utf8")).toBe(firstThreadId)
    } finally {
      await Promise.all(birds.map(stopBird))
    }
  }, 15_000)

  test("handles one message at a time and rejects empty messages and cycles", async () => {
    const bird = await startBird(join(await makeTemporaryDirectory(), "solo"), {
      HUMMINGBIRDS_FAKE_DELAY_MS: "200",
    })
    const inbox = startInbox()

    try {
      const questions = Array.from({ length: 5 }, (_, index) => `question ${index}`)
      const responses = await Promise.all(
        questions.map((question, index) =>
          send(bird, question, opaque(`request-${index}`), inbox.url),
        ),
      )
      expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202, 202])

      const cycle = await fetch(bird.url, {
        method: "POST",
        headers: {
          "x-route": JSON.stringify(["solo"]),
          "x-request": opaque("q-cycle"),
        },
        body: "cyclic question",
      })
      expect([cycle.status, await cycle.text()]).toEqual([409, "Cycle rejected at solo."])
      const empty = await send(bird, " \n", opaque("q-empty"), inbox.url)
      expect([empty.status, await empty.text()]).toEqual([400, "Empty message."])
      const invalidRoute = await fetch(new URL("/unknown", bird.url), {
        method: "POST",
        body: "Not a message endpoint.",
      })
      expect([invalidRoute.status, await invalidRoute.text()]).toEqual([
        404,
        "POST a plain-text message to /ask",
      ])
      expect((await send(bird, "just a command", opaque("q-command"))).status).toBe(202)

      await waitUntil(async () => {
        return (await events(bird)).filter((event) => event.kind === "completed").length === 6
      })
      const trace = await events(bird)
      const rejected = new Set(
        trace.filter((event) => event.kind === "rejected").map((event) => event.invocationId),
      )
      const admitted = trace
        .filter((event) => event.kind === "received" && !rejected.has(event.invocationId))
        .map((event) => event.requestId)
      const turns = trace.filter((event) => event.kind === "started" || event.kind === "completed")
      expect(turns.map((event) => event.kind)).toEqual(
        admitted.flatMap(() => ["started", "completed"]),
      )
      expect(turns.filter((event) => event.kind === "started").map((event) => event.requestId)).toEqual(
        admitted,
      )
      expect(inbox.messages).toEqual(
        questions.map((question, index) => ({
          body: `Handled by solo: ${question}`,
          from: "solo",
          inReplyTo: opaque(`request-${index}`),
          request: null,
        })),
      )
      await stopBird(bird)
      expect(await readRemainingOutput(bird.process.stdout)).toContain(
        "Handled by solo: just a command",
      )
    } finally {
      await stopBird(bird)
      inbox.stop()
    }
  }, 15_000)

  test("requires opaque exclusive request IDs and shows actual headers to birds", async () => {
    const root = await makeTemporaryDirectory()
    const source = await startBird(join(root, "source"), {
      HUMMINGBIRDS_SEED: "- Tideglass trial Nacre-A records the exact phrase “Opaque Harbor-17.”",
    })
    const receiver = await startBird(join(root, "receiver"), {
      HUMMINGBIRDS_PEERS: `- source at ${source.url}`,
    })
    const inbox = startInbox()
    const requestId = opaque("opaque-visible-request")

    try {
      for (const headers of [
        { "x-request": "create-child" },
        { "x-request": "not-a-uuid" },
        { "x-in-reply-to": "create-child" },
        { "x-request": requestId, "x-in-reply-to": requestId },
      ]) {
        const invalid = await fetch(receiver.url, {
          method: "POST",
          headers,
          body: "Unsafe or ambiguous correlation.",
        })
        expect(invalid.status).toBe(400)
      }
      for (const path of ["not-json", "{}", '["receiver", 42]']) {
        const invalid = await fetch(receiver.url, {
          method: "POST",
          headers: { "x-request": requestId, "x-route": path },
          body: "Invalid forwarding path.",
        })
        expect([invalid.status, await invalid.text()]).toEqual([
          400,
          "x-route must be a JSON array of node IDs",
        ])
      }
      expect(await events(receiver)).toEqual([])

      expect((await send(receiver, "What phrase belongs to Nacre-A?", requestId, inbox.url)).status).toBe(
        202,
      )
      await waitUntil(async () => {
        return (
          inbox.messages.length === 1 &&
          (await events(receiver)).some(
            (event) => event.kind === "completed" && event.inReplyTo === requestId,
          )
        )
      })
      expect(inbox.messages[0]?.inReplyTo).toBe(requestId)
      expect(inbox.messages[0]?.request).toBeNull()
      expect((await events(source)).find((event) => event.kind === "received")?.requestId).toBe(
        requestId,
      )

      for (const [bird, field] of [
        [source, "x-request"],
        [receiver, "x-in-reply-to"],
      ] as const) {
        const threadId = await readFile(join(bird.directory, "bird", "thread-id"), "utf8")
        const session = JSON.parse(
          await readFile(join(bird.directory, "bird", "workspace", ".fake-codex", `${threadId}.json`), "utf8"),
        ) as { lastEnvelope: Record<string, string> }
        expect(session.lastEnvelope[field]).toBe(requestId)
        expect(Object.keys(session.lastEnvelope)).toEqual(["x-from", field, "x-reply-to"])
        expect(session.lastEnvelope["x-route"]).toBeUndefined()
      }

      const automatic = await fetch(receiver.url, {
        method: "POST",
        headers: { "x-reply-to": inbox.url },
        body: "Generate my correlation ID.",
      })
      expect(automatic.status).toBe(202)
      const generated = automatic.headers.get("x-request")
      expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      expect(automatic.headers.has("x-invocation-id")).toBe(false)
      await waitUntil(async () => inbox.messages.length === 2)
      expect(inbox.messages[1]?.inReplyTo).toBe(generated)
      expect(inbox.messages[1]?.request).toBeNull()

      const notification = await fetch(receiver.url, {
        method: "POST",
        headers: { "x-from": "notifier" },
        body: "A one-way notification.",
      })
      expect(notification.status).toBe(202)
      const notificationId = notification.headers.get("x-request")
      if (notificationId === null) throw new Error("One-way message did not receive a request ID")
      await waitUntil(async () => {
        return (await events(receiver)).some(
          (event) => event.kind === "completed" && event.requestId === notificationId,
        )
      })
      expect(inbox.messages).toHaveLength(2)
      const receiverThreadId = await readFile(join(receiver.directory, "bird", "thread-id"), "utf8")
      const receiverSession = JSON.parse(
        await readFile(
          join(receiver.directory, "bird", "workspace", ".fake-codex", `${receiverThreadId}.json`),
          "utf8",
        ),
      ) as { lastEnvelope: Record<string, string> }
      expect(receiverSession.lastEnvelope).toEqual({
        "x-from": "notifier",
        "x-request": notificationId,
      })
    } finally {
      await Promise.all([stopBird(receiver), stopBird(source)])
      inbox.stop()
    }
  }, 15_000)

  test("hatches independent blank children and grandchildren that outlive their parent", async () => {
    const root = await makeTemporaryDirectory()
    const parent = await startBird(join(root, "parent"), {
      HUMMINGBIRDS_HATCH_MAX_BIRDS: "4",
      HUMMINGBIRDS_SEED: "PARENT-ONLY-SECRET-71",
    })
    const inbox = startInbox()
    const descendants: { directory: string; id: string; pid: number; url: string }[] = []

    async function hatch(url: string, id: string): Promise<(typeof descendants)[number]> {
      const response = await fetch(new URL("/hatch", url), { method: "POST", body: id })
      const body = await response.text()
      if (response.status !== 201) throw new Error(`Hatching ${id} failed: ${response.status} ${body}`)
      const match = new RegExp(`^Started ${id} at (http://127\\.0\\.0\\.1:\\d+/ask)\\.$`).exec(body)
      if (match === null || match[1] === undefined) throw new Error(`Unexpected hatch response: ${body}`)

      const directory = join(root, "parent", `bird-${id}`)
      const line = (await readFile(join(directory, "stdout.jsonl"), "utf8")).split("\n")[0]
      if (line === undefined) throw new Error(`Missing startup announcement for ${id}`)
      const startup = JSON.parse(line) as { id: string; pid: number; url: string }
      expect(startup.id).toBe(id)
      expect(startup.url).toBe(match[1])
      expect(Number.isSafeInteger(startup.pid)).toBe(true)
      const child = { directory, id, pid: startup.pid, url: startup.url }
      descendants.push(child)
      return child
    }

    async function ask(url: string, question: string, requestId: string): Promise<void> {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "x-reply-to": inbox.url,
          "x-request": opaque(requestId),
        },
        body: question,
      })
      expect(response.status).toBe(202)
    }

    try {
      for (const id of ["", "../escaped", "nested/child", "has spaces", "x".repeat(65)]) {
        const invalid = await fetch(new URL("/hatch", parent.url), { method: "POST", body: id })
        expect(invalid.status).toBe(400)
      }
      expect((await fetch(new URL("/hatch", parent.url))).status).toBe(405)

      const child = await hatch(parent.url, "sprout")
      const prompt = await readFile(join(child.directory, "workspace", "AGENTS.md"), "utf8")
      expect(prompt).toContain(`Your ID is sprout, and your address is ${child.url}.`)
      expect(prompt).toContain(`- parent at ${parent.url}`)
      expect(prompt).not.toContain("PARENT-ONLY-SECRET-71")

      let chatOutput = ""
      const chat = startChat(root, new URL(child.url).port, (chunk) => {
        chatOutput += chunk
      })
      const terminal = chat.terminal
      if (terminal === undefined) throw new Error("Child chat did not start in a terminal")
      try {
        await waitUntil(async () => Bun.stripANSI(chatOutput).includes(" You "))
        terminal.write("Hello from the terminal.\n")
        await waitUntil(async () => {
          return Bun.stripANSI(chatOutput).includes(
            "sprout  Handled by sprout: Hello from the terminal.",
          )
        })
      } finally {
        if (chat.exitCode === null) chat.kill()
        await chat.exited
        terminal.close()
      }

      const duplicate = await fetch(new URL("/hatch", parent.url), {
        method: "POST",
        body: "sprout",
      })
      expect(duplicate.status).toBe(409)

      const grandchild = await hatch(child.url, "twig")
      const grandchildPrompt = await readFile(
        join(grandchild.directory, "workspace", "AGENTS.md"),
        "utf8",
      )
      expect(grandchildPrompt).toContain(`- sprout at ${child.url}`)
      expect(grandchildPrompt).not.toContain(`- parent at ${parent.url}`)
      expect(grandchildPrompt).not.toContain("PARENT-ONLY-SECRET-71")

      const competing = await Promise.all(
        [parent.url, child.url].map((url) => {
          return fetch(new URL("/hatch", url), { method: "POST", body: "shared" })
        }),
      )
      expect(competing.map((response) => response.status).sort((left, right) => left - right)).toEqual([
        201,
        409,
      ])
      const sharedDirectory = join(root, "parent", "bird-shared")
      const sharedLine = (await readFile(join(sharedDirectory, "stdout.jsonl"), "utf8")).split("\n")[0]
      if (sharedLine === undefined) throw new Error("Missing startup announcement for shared")
      const shared = JSON.parse(sharedLine) as { id: string; pid: number; url: string }
      descendants.push({ ...shared, directory: sharedDirectory })

      const contenders = [
        { id: "last-parent", url: parent.url },
        { id: "last-child", url: child.url },
      ] as const
      const lastSlot = await Promise.all(
        contenders.map(({ id, url }) => {
          return fetch(new URL("/hatch", url), {
            method: "POST",
            body: id,
          })
        }),
      )
      expect(lastSlot.every((response) => response.status === 201 || response.status === 429)).toBe(true)
      expect(lastSlot.filter((response) => response.status === 201).length).toBeLessThanOrEqual(1)
      const acceptedName = contenders[lastSlot.findIndex((response) => response.status === 201)]?.id
      if (acceptedName === undefined) {
        await hatch(parent.url, "last-retry")
      } else {
        const acceptedDirectory = join(root, "parent", `bird-${acceptedName}`)
        const acceptedLine = (await readFile(join(acceptedDirectory, "stdout.jsonl"), "utf8")).split(
          "\n",
        )[0]
        if (acceptedLine === undefined) throw new Error(`Missing startup announcement for ${acceptedName}`)
        const accepted = JSON.parse(acceptedLine) as { id: string; pid: number; url: string }
        descendants.push({ ...accepted, directory: acceptedDirectory })
      }

      const overflow = await fetch(new URL("/hatch", grandchild.url), {
        method: "POST",
        body: "overflow",
      })
      expect(overflow.status).toBe(429)
      expect(await readdir(join(root, "parent"))).not.toContain("bird-overflow")

      await Promise.all([
        ask(parent.url, "parent message", "q-parent"),
        ask(child.url, "child message", "q-child"),
        ask(grandchild.url, "grandchild message", "q-grandchild"),
      ])
      await waitUntil(async () => inbox.messages.length === 3)
      expect(inbox.messages.map((message) => message.from).sort()).toEqual([
        "parent",
        "sprout",
        "twig",
      ])

      await waitUntil(async () => {
        const paths = [child.directory, grandchild.directory].map((directory) => {
          return Bun.file(join(directory, "thread-id")).exists()
        })
        return (await Promise.all(paths)).every(Boolean)
      })
      const childThread = await readFile(join(child.directory, "thread-id"), "utf8")
      const grandchildThread = await readFile(join(grandchild.directory, "thread-id"), "utf8")
      expect(childThread).not.toBe(grandchildThread)

      await stopBird(parent)
      await Promise.all([
        ask(child.url, "still independent", "q-child-again"),
        ask(grandchild.url, "still independent", "q-grandchild-again"),
      ])
      await waitUntil(async () => inbox.messages.length === 5)
      expect(await readFile(join(child.directory, "thread-id"), "utf8")).toBe(childThread)
      expect(await readFile(join(grandchild.directory, "thread-id"), "utf8")).toBe(grandchildThread)
    } finally {
      await stopBird(parent)
      for (const child of descendants.reverse()) {
        try {
          process.kill(child.pid, "SIGTERM")
        } catch {
          // An already-exited detached child has nothing left to clean up.
        }
      }
      inbox.stop()
    }
  }, 20_000)

  test("keeps Codex flags in the right place and reports corrupt conversation state", async () => {
    const bird = await startBird(join(await makeTemporaryDirectory(), "solo"), {
      HUMMINGBIRDS_CODEX_ARGS: " -m gpt-test  -c model_auto_compact_token_limit=20000 ",
    })
    const inbox = startInbox()

    try {
      const firstRequest = opaque("q-first")
      await send(bird, "first", firstRequest, inbox.url)
      await waitUntil(async () => {
        return (await events(bird)).some(
          (event) => event.kind === "completed" && event.requestId === firstRequest,
        )
      })
      const secondRequest = opaque("q-second")
      await send(bird, "second", secondRequest, inbox.url)
      await waitUntil(async () => {
        return (await events(bird)).some(
          (event) => event.kind === "completed" && event.requestId === secondRequest,
        )
      })

      const threadIdPath = join(bird.directory, "bird", "thread-id")
      const threadId = await readFile(threadIdPath, "utf8")
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
      const extra = ["-m", "gpt-test", "-c", "model_auto_compact_token_limit=20000"]
      const argvPath = join(bird.directory, "bird", "workspace", ".fake-codex", "argv.jsonl")
      const readArgv = async (): Promise<string[][]> =>
        (await readFile(argvPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      expect(await readArgv()).toEqual([
        ["--search", "exec", ...common, ...extra, "-"],
        ["--search", "exec", "resume", ...common, ...extra, threadId, "-"],
      ])

      await writeFile(threadIdPath, "")
      const thirdRequest = opaque("q-third")
      await send(bird, "third", thirdRequest, inbox.url)
      await waitUntil(async () => inbox.messages.length === 3)
      expect(inbox.messages[2]?.body).toMatch(/thread-id is empty$/)
      expect(inbox.messages[2]?.inReplyTo).toBe(thirdRequest)
      expect(inbox.messages[2]?.request).toBeNull()
      expect(await readArgv()).toHaveLength(2)

      const late = await fetch(bird.url, {
        method: "POST",
        headers: {
          "x-in-reply-to": thirdRequest,
          "x-reply-to": inbox.url,
        },
        body: "a late reply",
      })
      expect(late.status).toBe(202)
      await waitUntil(async () => {
        return (await events(bird)).filter((event) => event.kind === "failed").length === 2
      })
      expect(inbox.messages).toHaveLength(3)
    } finally {
      await stopBird(bird)
      inbox.stop()
    }
  }, 15_000)
})

async function startBird(
  directory: string,
  environment: Record<string, string> = {},
  port = 0,
): Promise<Bird> {
  await mkdir(directory, { recursive: true })
  const child = Bun.spawn([process.execPath, "run", resolve("src/server.ts")], {
    cwd: directory,
    env: {
      ...Bun.env,
      HUMMINGBIRDS_CODEX: fakeCodex,
      HUMMINGBIRDS_DIRECTORY: join(directory, "bird"),
      HUMMINGBIRDS_NODE_ID: basename(directory),
      ...environment,
      HUMMINGBIRDS_PORT: String(port),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  let output = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error("Bird exited before announcing its address")
      output += new TextDecoder().decode(value)
      const end = output.indexOf("\n")
      if (end < 0) continue
      const ready = JSON.parse(output.slice(0, end)) as { id: string; url: string }
      return { directory, id: ready.id, process: child, url: ready.url }
    }
  } catch (error) {
    child.kill()
    throw error
  } finally {
    reader.releaseLock()
  }
}

function startChat(
  directory: string,
  destination: string | undefined,
  receive: (chunk: string) => void,
  environment: Record<string, string> = {},
) {
  const decoder = new TextDecoder()
  return Bun.spawn(
    [process.execPath, "run", resolve("src/chat.ts"), ...(destination === undefined ? [] : [destination])],
    {
      cwd: directory,
      env: { ...Bun.env, ...environment },
      terminal: {
        cols: 120,
        rows: 24,
        data(_terminal, chunk) {
          receive(decoder.decode(chunk, { stream: true }))
        },
      },
    },
  )
}

function startInbox(): { messages: Message[]; stop: () => void; url: string } {
  const messages: Message[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      messages.push({
        body: await request.text(),
        from: request.headers.get("x-from") ?? "unknown",
        inReplyTo: request.headers.get("x-in-reply-to"),
        request: request.headers.get("x-request"),
      })
      return new Response("Accepted.", { status: 202 })
    },
  })
  return {
    messages,
    stop: () => void server.stop(true),
    url: `http://127.0.0.1:${server.port}/ask`,
  }
}

async function send(
  bird: Bird,
  question: string,
  requestId: string,
  replyTo?: string,
): Promise<Response> {
  return fetch(bird.url, {
    method: "POST",
    headers: {
      "x-request": requestId,
      ...(replyTo === undefined ? {} : { "x-reply-to": replyTo }),
    },
    body: question,
  })
}

function opaque(label: string): string {
  const hex = new Bun.CryptoHasher("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

async function events(bird: Pick<Bird, "directory">): Promise<Event[]> {
  const file = Bun.file(join(bird.directory, "bird", "events.jsonl"))
  if (!(await file.exists())) return []
  return (await file.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Event)
}

function received(
  events: Event[],
  requestId: string,
): [string, string | null, string | null, string[]][] {
  return events
    .filter((event) => event.kind === "received" && event.requestId === requestId)
    .map((event) => [event.callerId, event.replyTo, event.inReplyTo, event.path])
}

async function stopBird(bird: Bird): Promise<void> {
  if (bird.process.exitCode !== null) return
  bird.process.kill()
  await bird.process.exited
}

async function readRemainingOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return output + decoder.decode()
    output += decoder.decode(value, { stream: true })
  }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hummingbirds-"))
  temporaryDirectories.push(directory)
  return directory
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000
  for (;;) {
    if (await check()) return
    if (performance.now() >= deadline) throw new Error("Condition timed out")
    await Bun.sleep(10)
  }
}
