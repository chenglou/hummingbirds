import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createTestInstallation } from "./installation.ts"

type Result = { code: number; stderr: string; stdout: string }
type Event = { kind: string }
type Metadata = { id: string; port: number; host: string; bind: string; threadId: string | null }

const homes: string[] = []
const { cliCommand } = await createTestInstallation(await makeHome())

afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { force: true, recursive: true })))
})

describe("birds", () => {
  test("login forwards Codex options, input, diagnostics, and exit status", async () => {
    const home = await makeHome()
    const login = join(home, "login.ts")
    await writeFile(login, `#!${process.execPath}\n` +
      `console.log(JSON.stringify(process.argv.slice(2)))\n` +
      `console.error("Login diagnostics.")\n` +
      `if (!process.argv.includes("--help")) { console.log(await Bun.stdin.text()); process.exitCode = 7 }\n`,
    { mode: 0o700 })

    const help = await command(home, ["login", "--device-auth", "--help"], { BIRDS_TEST_CODEX: login })
    expect(help).toEqual({
      code: 0,
      stdout: '["login","--device-auth","--help"]\n',
      stderr: "Login diagnostics.\n",
    })

    const child = Bun.spawn([...cliCommand, "login", "--with-api-key"], {
      env: { ...Bun.env, BIRDS_HOME: home, BIRDS_TEST_CODEX: login },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await child.stdin.write("not-a-real-credential\n")
    await child.stdin.end()
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ code, stdout, stderr }).toEqual({
      code: 7,
      stdout: '["login","--with-api-key"]\nnot-a-real-credential\n\n',
      stderr: "Login diagnostics.\n",
    })
  })

  test("interrupting login terminates its waiting child", async () => {
    const home = await makeHome()
    const login = join(home, "waiting-login.ts")
    await writeFile(login, `#!${process.execPath}\n` +
      `process.on("SIGTERM", () => { console.log("Login cancelled."); process.exit(0) })\n` +
      `console.log("Waiting for login.")\n` +
      `setInterval(() => {}, 1000)\n`,
    { mode: 0o700 })
    const child = spawn(home, ["login"], { BIRDS_TEST_CODEX: login })
    let output = ""
    const reading = (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true })
    })()
    try {
      await waitUntil(async () => output.includes("Waiting for login."))
      child.kill("SIGINT")
      await waitUntil(async () => child.exitCode !== null)
      await reading
      expect(child.exitCode).toBe(0)
      expect(output).toContain("Login cancelled.")
      expect(await new Response(child.stderr).text()).toBe("")
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM")
      await child.exited
      await reading
    }
  })

  test("creates separate stopped birds with explicit bootstrap data and isolates homes", async () => {
    const home = await makeHome()
    const first = await command(home, ["new", "b"], { HUMMINGBIRDS_SEED: "B-ONLY-FACT-71" })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("Created b.")

    const b = await metadata(home, "b")
    const peers = `- b at http://127.0.0.1:${b.port}/ask`
    const second = await command(home, ["new", "a"], { HUMMINGBIRDS_PEERS: peers })
    expect(second.code).toBe(0)
    const a = await metadata(home, "a")
    expect(a.port).not.toBe(b.port)
    expect(a).toEqual({ id: "a", port: a.port, host: "127.0.0.1", bind: "127.0.0.1", threadId: null })
    expect(b.threadId).toBeNull()
    expect(await Bun.file(join(home, "a", "thread-id")).exists()).toBe(false)
    expect(await Bun.file(join(home, "b", "thread-id")).exists()).toBe(false)
    expect(await Bun.file(join(home, "a", "run.json")).exists()).toBe(false)
    expect(await Bun.file(join(home, "b", "run.json")).exists()).toBe(false)
    expect(await readFile(join(home, "a", "workspace", "AGENTS.md"), "utf8")).toContain(peers)
    expect(await readFile(join(home, "b", "workspace", "AGENTS.md"), "utf8")).toContain(
      "B-ONLY-FACT-71",
    )

    const listed = await command(home, ["list"])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain(`a\tstopped\thttp://127.0.0.1:${a.port}/ask`)
    expect(listed.stdout).toContain(`b\tstopped\thttp://127.0.0.1:${b.port}/ask`)
    expect((await command(home, ["new", "a"])).code).not.toBe(0)
    for (const id of ["", "../escaped", "nested/child", "has spaces", "x".repeat(65)]) {
      expect((await command(home, ["new", id])).code).not.toBe(0)
    }

    const collision = await command(home, ["new", "collision", "--port", String(b.port)])
    expect(collision.code).not.toBe(0)
    expect(collision.stderr).toContain(`Bird port ${b.port} is already assigned.`)
    expect(await readdir(home)).not.toContain("collision")

    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    try {
      expect((await command(home, ["new", "occupied", "--port", String(occupied.port)])).code).not.toBe(0)
      expect(await readdir(home)).not.toContain("occupied")
    } finally {
      await occupied.stop(true)
    }

    const otherHome = await makeHome()
    expect((await command(otherHome, ["new", "a"])).code).toBe(0)
    expect((await command(otherHome, ["list"])).stdout).not.toContain(`:${a.port}/ask`)
    const help = await command(home, ["--help"])
    expect(help.code).toBe(0)
    expect(help.stdout).not.toContain("--peer")
    const unsupported = await command(home, ["new", "unsupported", "--peer", "b"])
    expect(unsupported.code).not.toBe(0)
    expect(unsupported.stderr).toContain("Unknown option")
    expect(await readdir(home)).not.toContain("unsupported")
    expect(help.stdout).not.toContain("birds kill")
    const removed = await command(home, ["kill", "a"])
    expect(removed.code).not.toBe(0)
    expect(removed.stderr).toContain("Unknown command: kill")
    expect((await command(home, ["chat"])).code).not.toBe(0)
  }, 15_000)

  test("trusted CLI and server launches ignore bird-local Bun configuration", async () => {
    const home = await makeHome()
    const workspace = await makeHome()
    await writeFile(join(workspace, ".env"), "HUMMINGBIRDS_SEED=WORKSPACE-ENV-MUST-NOT-LOAD\n")
    await writeFile(join(workspace, "bunfig.toml"), 'preload = ["./unexpected.ts"]\n')
    await writeFile(join(workspace, "unexpected.ts"), 'throw new Error("Workspace preload must not run")\n')
    const child = Bun.spawn([...cliCommand, "new", "pinned"], {
      cwd: workspace,
      env: {
        ...Bun.env,
        BIRDS_HOME: home,
        BIRDS_HOST: undefined,
        BIRDS_BIND: undefined,
        HUMMINGBIRDS_MAX_BIRDS: undefined,
        HUMMINGBIRDS_PEERS: undefined,
        HUMMINGBIRDS_SEED: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("Created pinned.")
    expect(await readFile(join(home, "pinned", "workspace", "AGENTS.md"), "utf8"))
      .not.toContain("WORKSPACE-ENV-MUST-NOT-LOAD")

    const directory = join(home, "pinned")
    const capture = join(home, "capture-launch.ts")
    await writeFile(join(directory, ".env"), "BIRDS_TEST_LOCAL_ENV=STATE-ENV-MUST-NOT-LOAD\n")
    await writeFile(join(directory, "bunfig.toml"), 'preload = ["./unexpected.ts"]\n')
    await writeFile(join(directory, "unexpected.ts"), 'throw new Error("Bird state preload must not run")\n')
    await writeFile(capture, `#!${process.execPath}\n` +
      `await Bun.stdin.text()\n` +
      `await Bun.write("launch-environment.json", JSON.stringify({ cwd: process.cwd(), local: Bun.env["BIRDS_TEST_LOCAL_ENV"] ?? null }))\n` +
      `console.log(JSON.stringify({ type: "thread.started", thread_id: crypto.randomUUID() }))\n`,
    { mode: 0o700 })
    try {
      const started = await command(home, ["start", "pinned", "--detach"], { BIRDS_TEST_CODEX: capture })
      expect(started.code).toBe(0)
      const { port } = await metadata(home, "pinned")
      expect((await post(port, "Inspect the launch environment.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "pinned")).some((event) => event.kind === "completed"))
      expect(JSON.parse(await readFile(join(directory, "workspace", "launch-environment.json"), "utf8"))).toEqual({
        cwd: await realpath(join(directory, "workspace")),
        local: null,
      })
    } finally {
      await stopIfRunning(home, "pinned")
    }
  })

  test("reserves a bird ID exactly once across concurrent creation", async () => {
    const home = await makeHome()
    const competing = await Promise.all([
      command(home, ["new", "shared"]),
      command(home, ["new", "shared"]),
    ])
    expect(competing.map((result) => result.code).sort((left, right) => left - right)).toEqual([0, 1])
    const original = await readFile(join(home, "shared", "bird.json"), "utf8")
    const prompt = await readFile(join(home, "shared", "workspace", "AGENTS.md"), "utf8")
    expect(
      (await command(home, ["new", "shared"], { HUMMINGBIRDS_SEED: "MUST-NOT-REPLACE" })).code,
    ).toBe(1)
    expect(await readFile(join(home, "shared", "bird.json"), "utf8")).toBe(original)
    expect(await readFile(join(home, "shared", "workspace", "AGENTS.md"), "utf8")).toBe(prompt)
    expect(await readdir(home)).toEqual(["shared"])
  })

  test("persists advertised networking across restarts and manages the bound interface locally", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "networked"], {
      BIRDS_HOST: "Bird.EXAMPLE",
      BIRDS_BIND: "127.0.0.1",
    })).code).toBe(0)
    const saved = await metadata(home, "networked")
    expect(saved.host).toBe("bird.example")
    expect(saved.bind).toBe("127.0.0.1")
    const address = `http://bird.example:${saved.port}/ask`
    const promptPath = join(home, "networked", "workspace", "AGENTS.md")
    const prompt = await readFile(promptPath, "utf8")
    expect(prompt).toContain(`your address is ${address}.`)
    const changedEnvironment = { BIRDS_HOST: "wrong.example", BIRDS_BIND: "192.0.2.1" }

    try {
      const started = await command(home, ["start", "networked", "--detach"], changedEnvironment)
      expect({ code: started.code, stderr: started.stderr }).toEqual({ code: 0, stderr: "" })
      expect(started.stdout).toContain(address)
      expect((await command(home, ["list"], changedEnvironment)).stdout).toContain(`networked\trunning\t${address}`)
      expect((await fetch(`http://127.0.0.1:${saved.port}/control`)).status).toBe(401)
      expect((await post(saved.port, "First networked message.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "networked")).some((event) => event.kind === "completed"))
      const thread = (await metadata(home, "networked")).threadId
      expect(thread).toBeString()
      expect((await command(home, ["stop", "networked"], changedEnvironment)).code).toBe(0)
      expect((await command(home, ["start", "networked", "--detach"])).stdout).toContain(address)
      expect((await post(saved.port, "Second networked message.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "networked")).filter((event) => event.kind === "completed").length === 2)
      expect(await Bun.file(join(home, "networked", "thread-id")).exists()).toBe(false)
      expect(await readFile(promptPath, "utf8")).toBe(prompt)
      expect(await metadata(home, "networked")).toEqual({ ...saved, threadId: thread })
    } finally {
      await stopIfRunning(home, "networked")
    }
  })

  test("migrates a legacy bird's session only when starting and keeps its original prompt and localhost address", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "legacy"])).code).toBe(0)
    const { id, port } = await metadata(home, "legacy")
    const path = join(home, "legacy", "bird.json")
    const threadPath = join(home, "legacy", "thread-id")
    const legacy = JSON.stringify({ id, port })
    const promptPath = join(home, "legacy", "workspace", "AGENTS.md")
    const prompt = await readFile(promptPath, "utf8")
    try {
      expect((await command(home, ["start", "legacy", "--detach"])).code).toBe(0)
      expect((await post(port, "Remember this conversation before migrating.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "legacy")).some((event) => event.kind === "completed"))
      const thread = (await metadata(home, "legacy")).threadId
      if (thread === null) throw new Error("Expected a persisted conversation")
      expect((await command(home, ["stop", "legacy"])).code).toBe(0)
      await writeFile(path, legacy)
      await writeFile(threadPath, `${thread}\n`)

      expect((await command(home, ["list"])).stdout).toContain(`legacy\tstopped\thttp://127.0.0.1:${port}/ask`)
      expect(await readFile(path, "utf8")).toBe(legacy)
      expect(await readFile(threadPath, "utf8")).toBe(`${thread}\n`)

      const started = await command(home, ["start", "legacy", "--detach"], {
        BIRDS_HOST: "not-this-machine.example",
        BIRDS_BIND: "192.0.2.1",
      })
      expect(started.code).toBe(0)
      expect(started.stdout).toContain(`http://127.0.0.1:${port}/ask`)
      expect((await metadata(home, "legacy")).threadId).toBe(thread)
      expect(await Bun.file(threadPath).exists()).toBe(false)
      expect((await post(port, "Keep my old state.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "legacy")).filter((event) => event.kind === "completed").length === 2)
      expect(await metadata(home, "legacy")).toEqual({ id, port, host: "127.0.0.1", bind: "127.0.0.1", threadId: thread })
      expect(await readFile(promptPath, "utf8")).toBe(prompt)
    } finally {
      await stopIfRunning(home, "legacy")
    }
  })

  test("rejects invalid saved thread IDs without starting a fresh conversation or changing state", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "invalid"])).code).toBe(0)
    const saved = await metadata(home, "invalid")
    const directory = join(home, "invalid")
    const path = join(directory, "bird.json")
    for (const threadId of ["", "   ", 42, false, {}]) {
      const invalid = JSON.stringify({ ...saved, threadId })
      await writeFile(path, invalid)
      expect((await command(home, ["start", "invalid", "--detach"])).code).not.toBe(0)
      expect(await readFile(path, "utf8")).toBe(invalid)
      expect(await Bun.file(join(directory, "run.json")).exists()).toBe(false)
      expect(await Bun.file(join(directory, "thread-id")).exists()).toBe(false)
      expect(await events(home, "invalid")).toEqual([])
    }
  })

  test("limits retained bird directories to 32 by default", async () => {
    const home = await makeHome()
    for (let index = 0; index < 32; index++) {
      expect((await command(home, ["new", `bird-${index}`])).code).toBe(0)
    }
    const overflow = await command(home, ["new", "overflow"])
    expect(overflow.code).toBe(1)
    expect(overflow.stderr).toContain("Local bird limit reached.")
    expect(await readdir(home)).toHaveLength(32)
    expect(await Bun.file(join(home, "overflow", "bird.json")).exists()).toBe(false)
  }, 15_000)

  test("validates the configured cap and never overbooks a concurrent last slot", async () => {
    const home = await makeHome()
    for (const limit of ["0", "-1", "1.5", "NaN"]) {
      const invalid = await command(home, ["new", "invalid"], { HUMMINGBIRDS_MAX_BIRDS: limit })
      expect(invalid.code).toBe(1)
      expect(invalid.stderr).toContain("positive integer")
      expect(await readdir(home)).toEqual([])
    }
    const environment = { HUMMINGBIRDS_MAX_BIRDS: "2" }
    expect((await command(home, ["new", "retained"], environment)).code).toBe(0)
    const contenders = await Promise.all([
      command(home, ["new", "last-a"], environment),
      command(home, ["new", "last-b"], environment),
    ])
    expect(
      contenders.every((result) => result.code === 0 || result.stderr.includes("Local bird limit reached.")),
    ).toBe(true)
    const admitted = contenders.filter((result) => result.code === 0).length
    expect(admitted).toBeLessThanOrEqual(1)
    // Both reservations can see a full root before either rolls back.
    if (admitted === 0) expect((await command(home, ["new", "last-retry"], environment)).code).toBe(0)
    expect(await readdir(home)).toHaveLength(2)
    expect((await command(home, ["new", "overflow"], environment)).stderr).toContain("Local bird limit reached.")
    expect(await readdir(home)).not.toContain("overflow")
    expect((await command(home, ["list"])).stdout).toContain("retained\tstopped\t")
  })

  test("starts in the foreground, rejects duplicates, and resumes on its stable port", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "memory"])).code).toBe(0)
    const { port } = await metadata(home, "memory")
    const foreground = spawn(home, ["start", "memory"])

    try {
      await waitUntil(async () => (await command(home, ["list"])).stdout.includes("memory\trunning\t"))
      const run = JSON.parse(await readFile(join(home, "memory", "run.json"), "utf8")) as { token: string }
      const removed = await fetch(`http://127.0.0.1:${port}/control`, {
        method: "POST",
        headers: { authorization: `Bearer ${run.token}` },
        body: "kill",
      })
      expect([removed.status, await removed.text()]).toEqual([400, "Send stop."])
      expect((await command(home, ["start", "memory", "--detach"])).code).not.toBe(0)
      expect((await post(port, "Remember the first message.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "memory")).some((event) => event.kind === "completed"))
      const thread = (await metadata(home, "memory")).threadId
      expect(thread).toBeString()

      expect((await command(home, ["stop", "memory"])).code).toBe(0)
      await foreground.exited
      expect((await command(home, ["list"])).stdout).toContain("memory\tstopped\t")

      const restarted = await command(home, ["start", "memory", "--detach"])
      expect(restarted.code).toBe(0)
      expect(restarted.stdout).toContain(`http://127.0.0.1:${port}/ask`)
      expect((await post(port, "Remember the second message.")).status).toBe(202)
      await waitUntil(async () => {
        return (await events(home, "memory")).filter((event) => event.kind === "completed").length === 2
      })
      expect((await metadata(home, "memory")).threadId).toBe(thread)
      expect(await Bun.file(join(home, "memory", "thread-id")).exists()).toBe(false)

      let output = ""
      const decoder = new TextDecoder()
      const client = Bun.spawn([...cliCommand, "chat", "memory"], {
        env: { ...Bun.env, BIRDS_HOME: home, BIRDS_HOST: undefined, BIRDS_BIND: undefined },
        terminal: {
          cols: 120,
          rows: 24,
          data(_terminal, chunk) {
            output += decoder.decode(chunk, { stream: true })
          },
        },
      })
      const terminal = client.terminal
      if (terminal === undefined) throw new Error("Named chat did not start in a terminal")
      try {
        await waitUntil(async () => Bun.stripANSI(output).includes(" You "))
        terminal.write("Hello through my local name.\n")
        await waitUntil(async () => {
          return Bun.stripANSI(output).includes("memory  Handled by memory: Hello through my local name.")
        })
      } finally {
        client.kill()
        await client.exited
        terminal.close()
      }
    } finally {
      await stopIfRunning(home, "memory")
      if (foreground.exitCode === null) await foreground.exited
    }
  }, 20_000)

  test("stops gracefully after draining accepted messages and rejects new work", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "drain"])).code).toBe(0)
    expect(
      (await command(home, ["start", "drain", "--detach"], { HUMMINGBIRDS_FAKE_DELAY_MS: "450" })).code,
    ).toBe(0)
    const { port } = await metadata(home, "drain")

    try {
      expect((await post(port, "First accepted message.")).status).toBe(202)
      expect((await post(port, "Second accepted message.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "drain")).some((event) => event.kind === "started"))

      const late = await stalledPost(port, "This upload started before shutdown.")
      const stopping = command(home, ["stop", "drain"])
      await waitUntil(async () => (await command(home, ["list"])).stdout.includes("drain\tstopping\t"))
      await late.complete()
      expect((await late.response)?.status).toBe(503)
      expect((await post(port, "This message must be rejected.")).status).toBe(503)
      expect((await stopping).code).toBe(0)
      expect((await events(home, "drain")).filter((event) => event.kind === "completed")).toHaveLength(2)
      expect((await command(home, ["list"])).stdout).toContain("drain\tstopped\t")
      expect((await command(home, ["stop", "drain"])).code).toBe(0)
    } finally {
      await stopIfRunning(home, "drain")
    }
  }, 20_000)

  test("refuses to stop an unrelated process referenced by stale runtime state", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "stale"])).code).toBe(0)
    const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stderr: "ignore",
      stdout: "ignore",
    })

    try {
      await writeFile(
        join(home, "stale", "run.json"),
        JSON.stringify({ pid: unrelated.pid, token: "not-this-birds-token" }),
      )
      expect((await command(home, ["stop", "stale"])).code).not.toBe(0)
      expect(unrelated.exitCode).toBeNull()
    } finally {
      unrelated.kill()
      await unrelated.exited
    }
  })

  test("stops without waiting for an unaccepted message upload", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "blocked"])).code).toBe(0)
    expect((await command(home, ["start", "blocked", "--detach"])).code).toBe(0)
    const { port } = await metadata(home, "blocked")
    let unfinished: Awaited<ReturnType<typeof stalledPost>> | null = null

    try {
      unfinished = await stalledPost(port, "This message body never finishes.")
      const stoppingAt = performance.now()
      expect((await command(home, ["stop", "blocked"])).code).toBe(0)
      expect(performance.now() - stoppingAt).toBeLessThan(2_000)
      expect(await events(home, "blocked")).toEqual([])
      expect((await metadata(home, "blocked")).threadId).toBeNull()
      expect(await Bun.file(join(home, "blocked", "thread-id")).exists()).toBe(false)
    } finally {
      if (unfinished !== null) {
        unfinished.cancel()
        await unfinished.response
      }
      await stopIfRunning(home, "blocked")
    }
  }, 20_000)

  test("new birds have no inherited peers or memory and keep running after their creator stops", async () => {
    const home = await makeHome()
    expect(
      (await command(home, ["new", "parent"], { HUMMINGBIRDS_SEED: "PARENT-ONLY-FACT-71" })).code,
    ).toBe(0)
    expect((await command(home, ["start", "parent", "--detach"])).code).toBe(0)
    const parent = await metadata(home, "parent")
    const replies: { from: string | null; inReplyTo: string | null; request: string | null; body: string }[] = []
    const inbox = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        replies.push({
          from: request.headers.get("x-from"),
          inReplyTo: request.headers.get("x-in-reply-to"),
          request: request.headers.get("x-request"),
          body: await request.text(),
        })
        return new Response("Accepted.", { status: 202 })
      },
    })

    try {
      expect((await post(parent.port, "Remember the parent's own conversation.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "parent")).some((event) => event.kind === "completed"))
      const parentThread = (await metadata(home, "parent")).threadId
      expect(parentThread).toBeString()

      expect((await command(home, ["new", "sprout"])).code).toBe(0)
      const child = await metadata(home, "sprout")
      const prompt = await readFile(join(home, "sprout", "workspace", "AGENTS.md"), "utf8")
      expect(prompt).toContain(`Your ID is sprout, and your address is http://127.0.0.1:${child.port}/ask.`)
      expect(prompt).toContain("Your initial peers are:\n(none)")
      expect(prompt).not.toContain("--peer")
      expect(prompt).toContain("After splitting, tell each child about the peers you think are relevant to its work, including their IDs, addresses, and what you know about them.")
      expect(prompt).not.toContain("PARENT-ONLY-FACT-71")
      expect(child.threadId).toBeNull()
      expect(await Bun.file(join(home, "sprout", "thread-id")).exists()).toBe(false)
      expect(await readdir(join(home, "sprout", "workspace"))).toEqual(["AGENTS.md"])
      expect((await command(home, ["start", "sprout", "--detach"])).code).toBe(0)

      expect((await command(home, ["new", "twig"])).code).toBe(0)
      const grandchild = await metadata(home, "twig")
      const grandchildPrompt = await readFile(join(home, "twig", "workspace", "AGENTS.md"), "utf8")
      expect(grandchildPrompt).toContain("Your initial peers are:\n(none)")
      expect(grandchildPrompt).not.toContain("PARENT-ONLY-FACT-71")
      expect(grandchild.threadId).toBeNull()
      expect(await Bun.file(join(home, "twig", "thread-id")).exists()).toBe(false)
      expect((await command(home, ["start", "twig", "--detach"])).code).toBe(0)

      await Promise.all([
        post(child.port, "First sprout message."),
        post(grandchild.port, "First twig message."),
      ])
      await waitUntil(async () => (await events(home, "sprout")).some((event) => event.kind === "completed"))
      await waitUntil(async () => (await events(home, "twig")).some((event) => event.kind === "completed"))
      const childThread = (await metadata(home, "sprout")).threadId
      const grandchildThread = (await metadata(home, "twig")).threadId
      expect(childThread).toBeString()
      expect(grandchildThread).toBeString()
      expect(childThread).not.toBe(parentThread)
      expect(grandchildThread).not.toBe(parentThread)
      expect(childThread).not.toBe(grandchildThread)

      const listed = await command(home, ["list"])
      expect(listed.stdout).toContain("parent\trunning\t")
      expect(listed.stdout).toContain("sprout\trunning\t")
      expect(listed.stdout).toContain("twig\trunning\t")

      expect((await command(home, ["stop", "parent"])).code).toBe(0)
      for (const [id, port] of [["sprout", child.port], ["twig", grandchild.port]] as const) {
        const requestId = crypto.randomUUID()
        const response = await fetch(`http://127.0.0.1:${port}/ask`, {
          method: "POST",
          headers: {
            "x-request": requestId,
            "x-reply-to": `http://127.0.0.1:${inbox.port}/ask`,
          },
          body: "Still independent.",
        })
        expect(response.status).toBe(202)
        await waitUntil(async () => replies.some((reply) => reply.inReplyTo === requestId))
        expect(replies.find((reply) => reply.inReplyTo === requestId)).toEqual({
          from: id,
          inReplyTo: requestId,
          request: null,
          body: `Handled by ${id}: Still independent.`,
        })
      }
      expect(replies).toHaveLength(2)
      await waitUntil(async () => (await events(home, "sprout")).filter((event) => event.kind === "completed").length === 2)
      await waitUntil(async () => (await events(home, "twig")).filter((event) => event.kind === "completed").length === 2)
      expect((await metadata(home, "sprout")).threadId).toBe(childThread)
      expect((await metadata(home, "twig")).threadId).toBe(grandchildThread)
      expect(await Bun.file(join(home, "sprout", "thread-id")).exists()).toBe(false)
      expect(await Bun.file(join(home, "twig", "thread-id")).exists()).toBe(false)
      expect((await command(home, ["list"])).stdout).toContain("sprout\trunning\t")
    } finally {
      await Promise.all(["twig", "sprout", "parent"].map((id) => stopIfRunning(home, id)))
      await inbox.stop(true)
    }
  }, 20_000)
})

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hummingbirds-cli-"))
  homes.push(home)
  return home
}

function spawn(home: string, args: string[], environment: Record<string, string> = {}) {
  return Bun.spawn([...cliCommand, ...args], {
    env: {
      ...Bun.env,
      BIRDS_HOME: home,
      BIRDS_HOST: undefined,
      BIRDS_BIND: undefined,
      HUMMINGBIRDS_MAX_BIRDS: undefined,
      HUMMINGBIRDS_PEERS: undefined,
      HUMMINGBIRDS_SEED: undefined,
      ...environment,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
}

async function command(
  home: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<Result> {
  const child = spawn(home, args, environment)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

async function metadata(home: string, id: string): Promise<Metadata> {
  return JSON.parse(await readFile(join(home, id, "bird.json"), "utf8")) as Metadata
}

async function events(home: string, id: string): Promise<Event[]> {
  const file = Bun.file(join(home, id, "events.jsonl"))
  if (!(await file.exists())) return []
  return (await file.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Event)
}

async function post(port: number, message: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/ask`, { method: "POST", body: message })
}

async function stalledPost(port: number, message: string) {
  const abort = new AbortController()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()
  const response = fetch(`http://127.0.0.1:${port}/ask`, {
    method: "POST",
    body: stream.readable,
    signal: abort.signal,
  }).catch(() => null)
  await writer.write(new TextEncoder().encode(message))
  return { response, complete: () => writer.close(), cancel: () => abort.abort() }
}

async function stopIfRunning(home: string, id: string): Promise<void> {
  if (await Bun.file(join(home, id, "run.json")).exists()) await command(home, ["stop", id])
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error("Condition timed out")
    await Bun.sleep(10)
  }
}
