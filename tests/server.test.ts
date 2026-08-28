import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { basename, dirname, join, resolve } from "path"
import { cliCommand, createBird } from "../src/local.ts"

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
      expect(agents).not.toContain("HUMMINGBIRDS_REQUEST_ID")
      expect(agents).not.toContain("HUMMINGBIRDS_NODE_ID")
      expect(agents).not.toContain("HUMMINGBIRDS_NODE_ADDRESS")
      expect(agents).not.toContain("[command]")
      if (/^[A-Za-z0-9_./=-]+$/.test(process.execPath)) {
        expect(agents).toContain(`${process.execPath} --no-env-file`)
      }

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
    await createBird(join(directory, "bird"), "foreground")
    const decoder = new TextDecoder()
    let output = ""
    const child = Bun.spawn([process.execPath, "run", resolve("src/server.ts")], {
      cwd: directory,
      env: {
        ...Bun.env,
        HUMMINGBIRDS_CODEX: fakeCodex,
        HUMMINGBIRDS_DIRECTORY: join(directory, "bird"),
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

  test("attaches by port, host, or HTTP origin through the CLI", async () => {
    const bird = await startBird(join(await makeTemporaryDirectory(), "destinations"))
    const port = new URL(bird.url).port
    const destinations = [port, `localhost:${port}`, `http://127.0.0.1:${port}`]

    try {
      for (const [index, destination] of destinations.entries()) {
        let output = ""
        const child = startChat(bird.directory, destination, (chunk) => {
          output += chunk
        })
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

      const invalid = Bun.spawn([process.execPath, "run", resolve("src/cli.ts"), "chat", bird.url], {
        cwd: bird.directory,
        env: { ...Bun.env, BIRDS_HOME: bird.directory },
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
      HUMMINGBIRDS_REQUEST_ID: opaque("stale-inherited-request"),
      HUMMINGBIRDS_NODE_ID: "stale-parent",
      HUMMINGBIRDS_NODE_ADDRESS: "http://127.0.0.1:1/ask",
    })
    const receiver = await startBird(join(root, "receiver"), {
      HUMMINGBIRDS_PEERS: `- source at ${source.url}`,
      HUMMINGBIRDS_REQUEST_ID: opaque("stale-inherited-request"),
      HUMMINGBIRDS_NODE_ID: "stale-parent",
      HUMMINGBIRDS_NODE_ADDRESS: "http://127.0.0.1:1/ask",
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
      expect(inbox.messages[0]?.from).toBe(receiver.id)
      expect(received(await events(source), requestId)).toEqual([
        [receiver.id, receiver.url, null, [receiver.id]],
      ])
      const reply = (await events(receiver)).find(
        (event) => event.kind === "received" && event.inReplyTo === requestId,
      )
      expect(reply?.callerId).toBe(source.id)
      expect(reply?.replyTo).toBe(source.url)

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

  test("writes Codex configuration in the protected workspace directory and scopes its CLI rules", async () => {
    const bird = await startBird(join(await makeTemporaryDirectory(), "rules"))
    const stateDirectory = join(bird.directory, "bird")
    const configDirectory = join(stateDirectory, "workspace", ".codex")

    try {
      expect(await Bun.file(join(stateDirectory, ".codex", "config.toml")).exists()).toBe(false)
      expect(await Bun.file(join(stateDirectory, ".codex", "rules", "birds.rules")).exists()).toBe(false)
      expect(Bun.TOML.parse(await readFile(join(configDirectory, "config.toml"), "utf8"))).toEqual({
        approval_policy: "never",
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: { network_access: true },
      })
      const rules = join(configDirectory, "rules", "birds.rules")
      const commands = [
        { argv: [...cliCommand, "new", "sprout", "--peer", "rules"], allowed: true },
        { argv: [...cliCommand, "start", "sprout", "--detach"], allowed: true },
        { argv: [...cliCommand, "stop", "rules"], allowed: false },
        { argv: [...cliCommand, "list"], allowed: false },
        { argv: [process.execPath, "-e", "console.log('not a bird command')"], allowed: false },
        { argv: [process.execPath, require.resolve("../src/cli.ts"), "new", "sprout"], allowed: false },
        { argv: [...cliCommand.map((arg) => arg.startsWith("--cwd=") ? `--cwd=${bird.directory}` : arg), "new", "sprout"], allowed: false },
        { argv: [process.execPath, "--preload", "other.ts", ...cliCommand.slice(1), "new", "sprout"], allowed: false },
        { argv: [...cliCommand.slice(0, -1), join(bird.directory, "other.ts"), "new", "sprout"], allowed: false },
        { argv: ["/bin/sh", "-c", "printf ordinary-shell-command"], allowed: false },
      ]
      for (const { argv, allowed } of commands) {
        const checked = Bun.spawn([
          process.execPath, require.resolve("@openai/codex/bin/codex.js"),
          "execpolicy", "check", "--rules", rules, "--", ...argv,
        ], { stdout: "pipe", stderr: "pipe" })
        const [code, stdout, stderr] = await Promise.all([
          checked.exited, new Response(checked.stdout).text(), new Response(checked.stderr).text(),
        ])
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
        const decision = JSON.parse(stdout) as { decision?: string; matchedRules: object[] }
        expect(decision.matchedRules).toHaveLength(allowed ? 1 : 0)
        if (allowed) expect(decision.decision).toBe("allow")
      }
    } finally {
      await stopBird(bird)
    }
  }, 15_000)

  test("native workspace sandbox protects generated policy without disabling temporary writes", async () => {
    const root = await makeTemporaryDirectory()
    const bird = await startBird(join(root, "sandbox"))
    const workspace = join(bird.directory, "bird", "workspace")
    const configPath = join(workspace, ".codex", "config.toml")
    const rulesPath = join(workspace, ".codex", "rules", "birds.rules")
    const temporaryWrite = join(root, "outside-workspace.txt")
    const script = join(root, "check-boundary.cjs")
    const codexHome = join(root, "codex-home")

    try {
      await mkdir(codexHome)
      const config = await readFile(configPath, "utf8")
      const rules = await readFile(rulesPath, "utf8")
      await writeFile(script, `const { writeFileSync, renameSync } = require("fs")\n` +
        `const { join } = require("path")\n` +
        `const policy = join(process.cwd(), ".codex")\n` +
        `const results = {}\n` +
        `const writes = [\n` +
        `  ["workspace", () => writeFileSync("ordinary.txt", "ok")],\n` +
        `  ["temporary", () => writeFileSync(process.argv[2], "ok")],\n` +
        `  ["new-rule", () => writeFileSync(join(policy, "rules", "added.rules"), "probe")],\n` +
        `  ["config-overwrite", () => writeFileSync(join(policy, "config.toml"), "probe")],\n` +
        `  ["policy-rename", () => renameSync(policy, join(process.cwd(), ".codex-moved"))],\n` +
        `]\n` +
        `for (const [name, write] of writes) {\n` +
        `  try { write(); results[name] = null } catch (error) { results[name] = error.code }\n` +
        `}\n` +
        `console.log(JSON.stringify(results))\n`)
      const child = Bun.spawn([
        process.execPath, require.resolve("@openai/codex/bin/codex.js"), "sandbox",
        "-c", 'sandbox_mode="workspace-write"',
        "-c", "sandbox_workspace_write.writable_roots=[]",
        "-c", "sandbox_workspace_write.exclude_slash_tmp=false",
        "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=false",
        "-c", 'project_root_markers=[".codex"]',
        "-c", `projects={${JSON.stringify(workspace)}={trust_level="trusted"}}`,
        "--", process.execPath, "--no-env-file", script, temporaryWrite,
      ], { cwd: workspace, env: { ...Bun.env, CODEX_HOME: codexHome }, stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
      const results = JSON.parse(stdout) as Record<string, string | null>
      expect(results["workspace"]).toBeNull()
      expect(results["temporary"]).toBeNull()
      for (const action of ["new-rule", "config-overwrite", "policy-rename"]) {
        expect(results[action]).toMatch(/^(EPERM|EACCES|EROFS)$/)
      }
      expect(await readFile(join(workspace, "ordinary.txt"), "utf8")).toBe("ok")
      expect(await readFile(temporaryWrite, "utf8")).toBe("ok")
      expect(await readFile(configPath, "utf8")).toBe(config)
      expect(await readFile(rulesPath, "utf8")).toBe(rules)
      expect(await Bun.file(join(workspace, ".codex", "rules", "added.rules")).exists()).toBe(false)
    } finally {
      await stopBird(bird)
    }
  }, 15_000)

  test("pins model children to their own home and clears inherited initialization", async () => {
    const root = await makeTemporaryDirectory()
    const capture = join(root, "capture-environment.ts")
    await writeFile(capture, `#!${process.execPath}\n` +
      `const names = ["BIRDS_HOME", "HUMMINGBIRDS_SEED", "HUMMINGBIRDS_PEERS", "HUMMINGBIRDS_MAX_BIRDS"]\n` +
      `await Bun.stdin.text()\n` +
      `await Bun.write("captured-environment.json", JSON.stringify(Object.fromEntries(names.map(name => [name, Bun.env[name] ?? null]))))\n` +
      `console.log(JSON.stringify({ type: "thread.started", thread_id: crypto.randomUUID() }))\n`,
    { mode: 0o700 })
    const bird = await startBird(join(root, "owned"), {
      BIRDS_HOME: "wrong-relative-home",
      HUMMINGBIRDS_CODEX: capture,
      HUMMINGBIRDS_SEED: "ONLY-THIS-BIRDS-SEED",
      HUMMINGBIRDS_PEERS: "- initial at http://127.0.0.1:1/ask",
      HUMMINGBIRDS_MAX_BIRDS: "3",
    })

    try {
      expect((await send(bird, "Inspect the child environment.", opaque("child-environment"))).status).toBe(202)
      await waitUntil(async () => (await events(bird)).some((event) => event.kind === "completed"))
      expect(JSON.parse(await readFile(join(bird.directory, "bird", "workspace", "captured-environment.json"), "utf8"))).toEqual({
        BIRDS_HOME: bird.directory,
        HUMMINGBIRDS_SEED: null,
        HUMMINGBIRDS_PEERS: null,
        HUMMINGBIRDS_MAX_BIRDS: "3",
      })
      expect(await readFile(join(bird.directory, "bird", "workspace", "AGENTS.md"), "utf8")).toContain("ONLY-THIS-BIRDS-SEED")
    } finally {
      await stopBird(bird)
    }
  })

  test("runs the packaged Codex without a globally installed Codex or Node", async () => {
    const root = await makeTemporaryDirectory()
    const emptyPath = join(root, "empty-path")
    await mkdir(emptyPath)
    const bird = await startBird(join(root, "packaged"), {
      HUMMINGBIRDS_CODEX: undefined,
      HUMMINGBIRDS_CODEX_ARGS: "--help",
      PATH: emptyPath,
    })

    try {
      const workspace = join(bird.directory, "bird", "workspace")
      await writeFile(join(workspace, "bunfig.toml"), 'preload = ["./unexpected.ts"]\n')
      await writeFile(join(workspace, "unexpected.ts"), 'throw new Error("Bird workspace preload must not run")\n')
      expect((await send(bird, "Show the packaged CLI.", opaque("packaged-codex"))).status).toBe(202)
      await waitUntil(async () => {
        return (await events(bird)).some(
          (event) => event.kind === "failed" && event.error === "Codex did not report a thread ID",
        )
      })
      await stopBird(bird)
      const output = await readRemainingOutput(bird.process.stdout)
      expect(output).toContain("Usage: codex exec")
      expect(output).toContain("Codex did not report a thread ID")
    } finally {
      await stopBird(bird)
    }
  }, 15_000)

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
      const stateDirectory = join(bird.directory, "bird")
      const workspace = join(stateDirectory, "workspace")
      const extra = ["-m", "gpt-test", "-c", "model_auto_compact_token_limit=20000"]
      const argvPath = join(workspace, ".fake-codex", "argv.jsonl")
      const readArgv = async (): Promise<string[][]> =>
        (await readFile(argvPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      const argv = await readArgv()
      const projects = argv[0]?.find((argument) => argument.startsWith("projects="))
      if (projects === undefined) throw new Error("Codex did not receive project trust")
      expect(Bun.TOML.parse(projects)).toEqual({
        projects: {
          [workspace]: { trust_level: "trusted" },
        },
      })
      const common = [
        "--ignore-user-config",
        "--skip-git-repo-check",
        "-c",
        'project_root_markers=[".codex"]',
        "-c",
        projects,
        "--json",
      ]
      expect(argv).toEqual([
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
  environment: Record<string, string | undefined> = {},
  port = 0,
): Promise<Bird> {
  await mkdir(directory, { recursive: true })
  const stateDirectory = join(directory, "bird")
  if (!(await Bun.file(join(stateDirectory, "bird.json")).exists())) {
    const peers = environment["HUMMINGBIRDS_PEERS"]
    const seed = environment["HUMMINGBIRDS_SEED"]
    await createBird(stateDirectory, basename(directory), {
      ...(port === 0 ? {} : { port }),
      ...(peers === undefined ? {} : { peers }),
      ...(seed === undefined ? {} : { seed }),
    })
  }
  const child = Bun.spawn([process.execPath, "run", resolve("src/server.ts")], {
    cwd: directory,
    env: {
      ...Bun.env,
      HUMMINGBIRDS_CODEX: fakeCodex,
      HUMMINGBIRDS_DIRECTORY: stateDirectory,
      ...environment,
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
  destination: string,
  receive: (chunk: string) => void,
) {
  const decoder = new TextDecoder()
  return Bun.spawn(
    [process.execPath, "run", resolve("src/cli.ts"), "chat", destination],
    {
      cwd: directory,
      env: { ...Bun.env, BIRDS_HOME: directory },
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
