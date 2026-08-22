import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
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
  error?: string
  inReplyTo: string | null
  invocationId: string
  kind: "received" | "rejected" | "started" | "completed" | "failed"
  path: string[]
  question?: string
  replyTo: string | null
  requestId: string
  threadId?: string | null
}

type Message = { body: string; from: string; inReplyTo: string | null }

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

    try {
      bird = await startBird(directory, { PATH: dirname(process.execPath) })
      const originalBird = bird
      const agentsPath = join(directory, "bird", "workspace", "AGENTS.md")
      const agents = await readFile(agentsPath, "utf8")
      expect(agents).toContain(`Your ID is bird, and your address is ${bird.url}.`)
      expect(agents).not.toContain("[peers]")

      const first = await send(bird, "Remember Ben likes hiking.", "q-first")
      expect([first.status, await first.text()]).toEqual([202, "Accepted by bird."])
      await waitUntil(async () => {
        return (await events(originalBird)).some((event) => event.kind === "completed")
      })
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
      expect((await send(bird, "And Ben likes camping.", "q-second")).status).toBe(202)
      await waitUntil(async () => {
        return (await events(restartedBird)).filter((event) => event.kind === "completed").length === 2
      })
      expect(await readFile(threadIdPath, "utf8")).toBe(threadId)
    } finally {
      if (bird !== null) await stopBird(bird)
    }
  }, 15_000)

  test("accepts typed terminal messages alongside HTTP on the same conversation", async () => {
    const directory = join(await makeTemporaryDirectory(), "interactive")
    await mkdir(directory, { recursive: true })
    const peer = startInbox()
    const peerAddress = new URL("/ask", peer.url).href
    const decoder = new TextDecoder()
    let output = ""
    const child = Bun.spawn([process.execPath, "run", resolve("src/server.ts")], {
      cwd: directory,
      env: {
        ...Bun.env,
        HUMMINGBIRDS_CODEX: fakeCodex,
        HUMMINGBIRDS_DIRECTORY: join(directory, "bird"),
        HUMMINGBIRDS_FAKE_DELAY_MS: "100",
        HUMMINGBIRDS_NODE_ID: "interactive",
        HUMMINGBIRDS_PEERS: `- b at ${peerAddress}`,
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
    if (terminal === undefined) throw new Error("Bird did not start in a terminal")

    const readEvents = async (): Promise<Event[]> => {
      const file = Bun.file(join(directory, "bird", "events.jsonl"))
      if (!(await file.exists())) return []
      return (await file.text())
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Event)
    }

    try {
      await waitUntil(async () => output.includes('"id":"interactive"'))
      const ready = JSON.parse(output.split("\n")[0] ?? "") as { url: string }
      await waitUntil(async () => Bun.stripANSI(output).includes(" You "))

      terminal.write("\nFirst typed message\n  \n")
      await waitUntil(async () => {
        return (await readEvents()).some((event) => event.question === "First typed message")
      })
      await waitUntil(async () => {
        return (Bun.stripANSI(output).split(/[\r\n]/).at(-1) ?? "").includes(" You ")
      })

      const httpMessage = "Ordinary HTTP message\n\u001b[31mSecond line\u001b[0m"
      const response = await fetch(ready.url, {
        method: "POST",
        headers: {
          "x-hummingbirds-caller-id": "peer-a",
          "x-hummingbirds-request-id": "q-http",
        },
        body: httpMessage,
      })
      expect(response.status).toBe(202)
      terminal.write("Second typed message\n\n")

      await waitUntil(async () => {
        return (await readEvents()).filter((event) => event.kind === "completed").length === 3
      })
      const trace = await readEvents()
      const incoming = trace.filter((event) => event.kind === "received")
      expect(incoming.map((event) => event.question)).toEqual([
        "First typed message",
        httpMessage,
        "Second typed message",
      ])
      expect(incoming.map((event) => event.callerId)).toEqual(["human", "peer-a", "human"])

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
      expect(output).toContain('"kind":"received"')
      expect(output).toContain('"type":"thread.started"')
      expect(output).toContain('"type":"item.completed"')
      const coloredOutput = output.replaceAll("\u001b", "ESC")
      expect(coloredOutput).toMatch(/ESC\[90m\{"callerId":"human"/)
      expect(coloredOutput).toMatch(/ESC\[90m\{"thread_id":/)
      const promptColors = [...coloredOutput.matchAll(/ESC\[30;(10[1-6])m You ESC\[0m/g)].map(
        (match) => match[1],
      )
      expect(promptColors.length).toBeGreaterThanOrEqual(2)
      expect(promptColors.every((color) => color === promptColors[0])).toBe(true)
      expect(coloredOutput).toMatch(
        /ESC\[90m\{"item":\{[^\r\n]*"text":"Handled by interactive: First typed message"[^\r\n]*"type":"agent_message"\},"type":"item.completed"\}ESC\[0m\r?\nESC\[30;10[1-6]m interactive \(self\) ESC\[0m Handled by interactive: First typed message/,
      )
      expect(coloredOutput).not.toMatch(/ESC\[30;10[1-6]m H ESC\[0m/)
      expect(coloredOutput).not.toMatch(/ESC\[30;10[1-6]m (P|peer-a) ESC\[0m/)
      expect(coloredOutput).toMatch(
        /ESC\[90m\{"callerId":"peer-a"[^\r\n]*"kind":"received"\}ESC\[0m\r?\n← peer-a  Ordinary HTTP message/,
      )
      const plainOutput = Bun.stripANSI(output)
      expect(plainOutput).toContain(" You ")
      expect(plainOutput).toMatch(/← peer-a  Ordinary HTTP message\r?\n {4}Second line\r?\n/)
      expect(plainOutput).toMatch(
        / interactive \(self\)  Handled by interactive: Ordinary HTTP message\r?\n {4}Second line\r?\n/,
      )
      const visibleLines = Bun.stripANSI(
        output
          .replaceAll("\u001b[2K", "\r")
          .replaceAll("\u001b[0K", "\r")
          .replaceAll("\u001b[1G", "\r"),
      ).split(/[\r\n]/)
      expect(visibleLines.filter((line) => line.includes(" You ") && line.includes('{"'))).toEqual([])
      expect(output).not.toContain("\u001b[31m")
      expect(await readFile(join(directory, "bird", "events.jsonl"), "utf8")).not.toContain(
        "\u001b[",
      )

      terminal.write("What does b know about Nacre-A?\n")
      await waitUntil(async () => {
        return (
          peer.messages.length === 1 &&
          output.includes("→ b  What does b know about Nacre-A?") &&
          (await readEvents()).filter((event) => event.kind === "completed").length === 4
        )
      })
      expect(peer.messages[0]?.body).toBe("What does b know about Nacre-A?")
      const outboundOutput = output.replaceAll("\u001b", "ESC")
      expect(outboundOutput).toMatch(
        /ESC\[90m\{"type":"item.started","item":\{[^\r\n]*"type":"command_execution"[^\r\n]*\}\}ESC\[0m\r?\n→ b  What does b know about Nacre-A\?\r?\n/,
      )
      expect(outboundOutput.match(/→ b  What does b know about Nacre-A\?/g)).toHaveLength(1)
      const executions = Bun.stripANSI(output)
        .split(/[\r\n]/)
        .filter(
          (line) => line.startsWith('{"type":"item.') && line.includes('"type":"command_execution"'),
        )
        .map((line) => JSON.parse(line) as { item: { command: string; id: string }; type: string })
      expect(executions.map((event) => event.type)).toEqual(["item.started", "item.completed"])
      expect(executions[0]?.item.id).toBe(executions[1]?.item.id)
      expect(executions[0]?.item.command).toBe(executions[1]?.item.command)
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      terminal.close()
      peer.stop()
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

      const training = await send(a, "What harbor phrase belongs to Nacre-A?", "q-train")
      expect(training.status).toBe(202)
      await waitUntil(async () => {
        return (await events(a)).some(
          (event) => event.kind === "completed" && event.inReplyTo === "q-train",
        )
      })
      const trainingReply = (await events(a)).find(
        (event) => event.kind === "received" && event.inReplyTo === "q-train",
      )
      expect(trainingReply?.question).toBe(`Amber Tern-417.\n\nContributors: c at ${c.url}`)
      expect(received(await events(a), "q-train")).toEqual([
        ["human", null, null, []],
        ["b", b.url, "q-train", ["a", "b"]],
      ])
      expect(received(await events(b), "q-train")).toEqual([
        ["a", a.url, null, ["a"]],
        ["c", c.url, "q-train", ["a", "b", "c"]],
      ])
      expect(received(await events(c), "q-train")).toEqual([["b", b.url, null, ["a", "b"]]])

      const firstThreadId = await readFile(join(a.directory, "bird", "thread-id"), "utf8")
      const port = Number(new URL(a.url).port)
      await stopBird(a)
      a = await startBird(a.directory, {}, port)
      birds[2] = a

      const probe = await send(a, "What harbor phrase belongs to Nacre-B?", "q-probe")
      expect(probe.status).toBe(202)
      await waitUntil(async () => {
        return (await events(a)).some(
          (event) => event.kind === "completed" && event.inReplyTo === "q-probe",
        )
      })
      const probeReply = (await events(a)).find(
        (event) => event.kind === "received" && event.inReplyTo === "q-probe",
      )
      expect(probeReply?.question).toBe(`Violet Shoal-862.\n\nContributors: c at ${c.url}`)
      expect(received(await events(a), "q-probe")).toEqual([
        ["human", null, null, []],
        ["c", c.url, "q-probe", ["a", "c"]],
      ])
      expect(received(await events(b), "q-probe")).toEqual([])
      expect(received(await events(c), "q-probe")).toEqual([["a", a.url, null, ["a"]]])
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
        questions.map((question, index) => send(bird, question, `request-${index}`, inbox.url)),
      )
      expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202, 202])

      const cycle = await fetch(bird.url, {
        method: "POST",
        headers: {
          "x-hummingbirds-path": JSON.stringify(["solo"]),
          "x-hummingbirds-request-id": "q-cycle",
        },
        body: "cyclic question",
      })
      expect([cycle.status, await cycle.text()]).toEqual([409, "Cycle rejected at solo."])
      const empty = await send(bird, " \n", "q-empty", inbox.url)
      expect([empty.status, await empty.text()]).toEqual([400, "Empty message."])
      expect((await send(bird, "just a command", "q-command")).status).toBe(202)

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
      expect(inbox.messages).toHaveLength(5)
      await stopBird(bird)
      expect(await readRemainingOutput(bird.process.stdout)).toContain(
        "Handled by solo: just a command",
      )
    } finally {
      await stopBird(bird)
      inbox.stop()
    }
  }, 15_000)

  test("keeps Codex flags in the right place and reports corrupt conversation state", async () => {
    const bird = await startBird(join(await makeTemporaryDirectory(), "solo"), {
      HUMMINGBIRDS_CODEX_ARGS: " -m gpt-test  -c model_auto_compact_token_limit=20000 ",
    })
    const inbox = startInbox()

    try {
      await send(bird, "first", "q-first", inbox.url)
      await waitUntil(async () => {
        return (await events(bird)).some(
          (event) => event.kind === "completed" && event.requestId === "q-first",
        )
      })
      await send(bird, "second", "q-second", inbox.url)
      await waitUntil(async () => {
        return (await events(bird)).some(
          (event) => event.kind === "completed" && event.requestId === "q-second",
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
      await send(bird, "third", "q-third", inbox.url)
      await waitUntil(async () => inbox.messages.length === 3)
      expect(inbox.messages[2]?.body).toMatch(/thread-id is empty$/)
      expect(await readArgv()).toHaveLength(2)

      const late = await fetch(bird.url, {
        method: "POST",
        headers: {
          "x-hummingbirds-in-reply-to": "q-third",
          "x-hummingbirds-reply-to": inbox.url,
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

function startInbox(): { messages: Message[]; stop: () => void; url: string } {
  const messages: Message[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      messages.push({
        body: await request.text(),
        from: request.headers.get("x-hummingbirds-caller-id") ?? "unknown",
        inReplyTo: request.headers.get("x-hummingbirds-in-reply-to"),
      })
      return new Response("Accepted.", { status: 202 })
    },
  })
  return {
    messages,
    stop: () => void server.stop(true),
    url: `http://127.0.0.1:${server.port}/inbox`,
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
      "x-hummingbirds-request-id": requestId,
      ...(replyTo === undefined ? {} : { "x-hummingbirds-reply-to": replyTo }),
    },
    body: question,
  })
}

async function events(bird: Bird): Promise<Event[]> {
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
