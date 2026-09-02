import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createTestInstallation } from "./installation.ts"

type Result = { code: number; stderr: string; stdout: string }
type Event = { kind: string }
type Network = { host: string; bind: string; port: number }
type Metadata = { id: string; network: Network | null; threadId: string | null }
type Runtime = { pid: number; token: string; ready: boolean }

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
    const first = await command(home, ["new", "b"], {
      BIRDS_HOST: "ignored.invalid",
      BIRDS_BIND: "not a listening interface",
      HUMMINGBIRDS_SEED: "B-ONLY-FACT-71",
    })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("Created b.")

    const peers = "- remote at http://bird.example:3002/"
    const second = await command(home, ["new", "a"], { HUMMINGBIRDS_PEERS: peers })
    expect(second.code).toBe(0)
    expect(await metadata(home, "a")).toEqual({ id: "a", network: null, threadId: null })
    expect(await metadata(home, "b")).toEqual({ id: "b", network: null, threadId: null })
    expect(await Bun.file(join(home, "a", "thread-id")).exists()).toBe(false)
    expect(await Bun.file(join(home, "b", "thread-id")).exists()).toBe(false)
    expect(await runtime(home, "a")).toBeNull()
    expect(await runtime(home, "b")).toBeNull()
    expect(await readFile(join(home, "a", "workspace", "AGENTS.md"), "utf8")).toContain(peers)
    expect(await readFile(join(home, "b", "workspace", "AGENTS.md"), "utf8")).toContain(
      "B-ONLY-FACT-71",
    )

    const listed = await command(home, ["list"])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain("a\tstopped\t-\n")
    expect(listed.stdout).toContain("b\tstopped\t-\n")
    expect((await command(home, ["new", "a"])).code).not.toBe(0)
    for (const id of ["", "../escaped", "nested/child", "has spaces", "x".repeat(65)]) {
      expect((await command(home, ["new", id])).code).not.toBe(0)
    }

    const otherHome = await makeHome()
    expect((await command(otherHome, ["new", "a"])).code).toBe(0)
    expect((await command(otherHome, ["list"])).stdout).not.toContain("b\t")
    const help = await command(home, ["--help"])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("--address")
    expect(help.stdout).toContain("--bind")
    expect(help.stdout).not.toContain("--host")
    expect(help.stdout).not.toContain("--port")
    expect(help.stdout).not.toContain("BIRDS_HOST")
    expect(help.stdout).not.toContain("BIRDS_BIND")
    expect(help.stdout).not.toContain("--peer")
    for (const option of ["--peer=b", "--host=127.0.0.1", "--port=3001", "--address=127.0.0.1:3001", "--bind=127.0.0.1", "--detach"]) {
      const unsupported = await command(home, ["new", "unsupported", option])
      expect(unsupported.code).not.toBe(0)
      expect(unsupported.stderr).toContain("Unknown option")
      expect(await readdir(home)).not.toContain("unsupported")
    }
    expect(help.stdout).not.toContain("birds kill")
    const removed = await command(home, ["kill", "a"])
    expect(removed.code).not.toBe(0)
    expect(removed.stderr).toContain("Unknown command: kill")
    expect((await command(home, ["chat"])).code).not.toBe(0)
    const unstarted = await command(home, ["chat", "a"])
    expect(unstarted.code).toBe(1)
    expect(unstarted.stderr).toContain("Start it with birds start a.")
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
        BIRDS_BIND: undefined,
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
      const { port } = await network(home, "pinned")
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

  test.each([
    ["127.0.0.1", "127.0.0.1"],
    ["Bird.EXAMPLE", "bird.example"],
  ])("assigns a free port for host-only %s and preserves the address across restarts", async (host, normalized) => {
    const home = await makeHome()
    expect((await command(home, ["new", "networked"])).code).toBe(0)
    expect((await metadata(home, "networked")).network).toBeNull()
    const promptPath = join(home, "networked", "workspace", "AGENTS.md")
    const changedEnvironment = { BIRDS_BIND: "192.0.2.1" }

    try {
      const bindArgs = normalized === "127.0.0.1" ? [] : ["--bind", "LOCALHOST"]
      const started = await command(home, ["start", "networked", "--address", host, ...bindArgs, "--detach"], changedEnvironment)
      expect({ code: started.code, stderr: started.stderr }).toEqual({ code: 0, stderr: "" })
      const saved = await metadata(home, "networked")
      const assigned = await network(home, "networked")
      expect(assigned.host).toBe(normalized)
      expect(assigned.bind).toBe("127.0.0.1")
      expect(assigned.port).toBeGreaterThan(0)
      const address = `http://${normalized}:${assigned.port}/`
      const prompt = await readFile(promptPath, "utf8")
      expect(prompt).toContain(`your address is ${address}.`)
      const childBind = normalized === "127.0.0.1" ? "" : " --bind 127.0.0.1"
      expect(prompt).toContain(`start <id> --address ${normalized}${childBind} --detach`)
      expect(prompt).not.toContain("[host]")
      expect(started.stdout).toContain(address)
      expect(await events(home, "networked")).toEqual([])
      expect((await command(home, ["list"], changedEnvironment)).stdout).toContain(`networked\trunning\t${address}`)
      expect((await fetch(`http://127.0.0.1:${assigned.port}/control`)).status).toBe(401)
      expect((await post(assigned.port, "First networked message.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "networked")).some((event) => event.kind === "completed"))
      const thread = (await metadata(home, "networked")).threadId
      expect(thread).toBeString()
      expect((await command(home, ["stop", "networked"], changedEnvironment)).code).toBe(0)
      expect((await command(home, ["start", "networked", "--detach"], changedEnvironment)).stdout).toContain(address)
      expect((await post(assigned.port, "Second networked message.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "networked")).filter((event) => event.kind === "completed").length === 2)
      expect(await Bun.file(join(home, "networked", "thread-id")).exists()).toBe(false)
      expect(await readFile(promptPath, "utf8")).toBe(prompt)
      expect(await metadata(home, "networked")).toEqual({ ...saved, threadId: thread })
    } finally {
      await stopIfRunning(home, "networked")
    }
  })

  test("readdressing a stopped bird updates only managed prompt data and preserves its conversation", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "moving"])).code).toBe(0)
    const promptPath = join(home, "moving", "workspace", "AGENTS.md")
    const customization = "\nMy owner added this: retain these instructions exactly.\n"
    const custom = (await readFile(promptPath, "utf8"))
      .replace("Handle each incoming message as well as you can", "Handle messages with my custom instruction") + customization
    await writeFile(promptPath, custom)

    try {
      expect((await command(home, ["start", "moving", "--detach"])).code).toBe(0)
      const originalNetwork = await network(home, "moving")
      expect(originalNetwork).toEqual({ host: "127.0.0.1", bind: "127.0.0.1", port: originalNetwork.port })
      expect((await post(originalNetwork.port, "Remember my original conversation.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "moving")).some((event) => event.kind === "completed"))
      const thread = (await metadata(home, "moving")).threadId
      expect(thread).toBeString()
      expect((await command(home, ["stop", "moving"])).code).toBe(0)

      const changed = await command(home, ["start", "moving", "--address", "New.EXAMPLE:0", "--bind", "127.0.0.1", "--detach"])
      expect({ code: changed.code, stderr: changed.stderr }).toEqual({ code: 0, stderr: "" })
      const assigned = await network(home, "moving")
      expect(assigned).toEqual({ host: "new.example", bind: "127.0.0.1", port: assigned.port })
      expect(changed.stdout).toContain(`http://new.example:${assigned.port}/`)
      const prompt = await readFile(promptPath, "utf8")
      const outsideRuntime = (text: string) => text.replace(/<!-- birds:runtime -->[\s\S]*?<!-- \/birds:runtime -->/, "")
      expect(outsideRuntime(prompt)).toBe(outsideRuntime(custom))
      expect(prompt).toContain("start <id> --address new.example --bind 127.0.0.1 --detach")
      expect(prompt).toContain(`your address is http://new.example:${assigned.port}/.`)
      expect(prompt).not.toContain(`your address is http://127.0.0.1:${originalNetwork.port}/.`)
      expect((prompt.match(/<!-- birds:runtime -->/g) ?? [])).toHaveLength(1)
      expect((await metadata(home, "moving")).threadId).toBe(thread)
      expect((await post(assigned.port, "Continue the original conversation.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "moving")).filter((event) => event.kind === "completed").length === 2)
      expect((await metadata(home, "moving")).threadId).toBe(thread)
    } finally {
      await stopIfRunning(home, "moving")
    }
  })

  test("bind-only restarts retain the advertised address and memory; new addresses reset the bind default", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "rebind"])).code).toBe(0)
    const obsoleteEnvironment = { BIRDS_BIND: "192.0.2.1" }
    try {
      expect((await command(home, ["start", "rebind", "--address", "bird.example", "--bind", "127.0.0.1", "--detach"], obsoleteEnvironment)).code).toBe(0)
      const original = await network(home, "rebind")
      expect((await post(original.port, "Remember me before changing listeners.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "rebind")).some((event) => event.kind === "completed"))
      const threadId = (await metadata(home, "rebind")).threadId
      expect(threadId).toBeString()
      expect((await command(home, ["stop", "rebind"])).code).toBe(0)

      const rebound = await command(home, ["start", "rebind", "--bind", "0.0.0.0", "--detach"], obsoleteEnvironment)
      expect(rebound.code).toBe(0)
      expect(rebound.stdout).toContain(`http://bird.example:${original.port}/`)
      expect(await network(home, "rebind")).toEqual({ ...original, bind: "0.0.0.0" })
      expect((await metadata(home, "rebind")).threadId).toBe(threadId)
      expect(await readFile(join(home, "rebind", "workspace", "AGENTS.md"), "utf8"))
        .toContain("start <id> --address bird.example --bind 0.0.0.0 --detach")
      expect((await post(original.port, "Continue on the new listener.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "rebind")).filter((event) => event.kind === "completed").length === 2)
      expect((await command(home, ["stop", "rebind"])).code).toBe(0)

      expect((await command(home, ["start", "rebind", "--detach"], obsoleteEnvironment)).code).toBe(0)
      expect(await network(home, "rebind")).toEqual({ ...original, bind: "0.0.0.0" })
      expect((await command(home, ["stop", "rebind"])).code).toBe(0)
      expect((await command(home, ["start", "rebind", "--address", "127.0.0.1", "--detach"], obsoleteEnvironment)).code).toBe(0)
      const changed = await network(home, "rebind")
      expect(changed).toEqual({ host: "127.0.0.1", bind: "127.0.0.1", port: changed.port })
      expect(await readFile(join(home, "rebind", "workspace", "AGENTS.md"), "utf8"))
        .toContain("start <id> --address 127.0.0.1 --detach")
      expect((await post(changed.port, "Continue after resetting the listener default.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "rebind")).filter((event) => event.kind === "completed").length === 3)
      expect((await metadata(home, "rebind")).threadId).toBe(threadId)
    } finally {
      await stopIfRunning(home, "rebind")
    }
  })

  test("rejects invalid address syntax and removed networking options without changing a bird", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "invalid"])).code).toBe(0)
    const statePath = join(home, "invalid", "bird.json")
    const promptPath = join(home, "invalid", "workspace", "AGENTS.md")
    const state = await readFile(statePath, "utf8")
    const prompt = await readFile(promptPath, "utf8")
    for (const address of [
      "", "bird.example:", ":3001", "--help", "http://bird.example:3001",
      "bird.example:3001/path", "bird.example:3001?query", "bird.example:3001#fragment",
      "user@bird.example:3001", "bird.example:-1", "bird.example:65536", "bird.example:3.5",
      "bird.example:NaN", "bad host:3001", "2001:db8::7:3001", "[2001:db8::7]:",
    ]) {
      expect((await command(home, ["start", "invalid", `--address=${address}`, "--detach"])).code).toBe(1)
      expect(await readFile(statePath, "utf8")).toBe(state)
      expect(await readFile(promptPath, "utf8")).toBe(prompt)
      expect(await runtime(home, "invalid")).toBeNull()
    }
    for (const bind of [
      "", "--help", "127.0.0.1:3001", "http://127.0.0.1", "[::1]:3001", "[::1",
      "has spaces", "host/path", "host?query", "host#fragment", "user@host",
    ]) {
      expect((await command(home, ["start", "invalid", `--bind=${bind}`, "--detach"])).code).toBe(1)
      expect(await readFile(statePath, "utf8")).toBe(state)
      expect(await readFile(promptPath, "utf8")).toBe(prompt)
      expect(await runtime(home, "invalid")).toBeNull()
    }
    for (const option of ["--host=127.0.0.1", "--port=3001"]) {
      const result = await command(home, ["start", "invalid", option, "--detach"])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Unknown option")
    }
    expect(await events(home, "invalid")).toEqual([])
  })

  test("occupied or assigned ports never replace saved networking or prompt data", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "blocked"])).code).toBe(0)
    const statePath = join(home, "blocked", "bird.json")
    const promptPath = join(home, "blocked", "workspace", "AGENTS.md")
    // A foreign listener can mimic /control, but cannot complete this bird's startup.
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("running") })
    try {
      const original = await readFile(statePath, "utf8")
      const originalPrompt = await readFile(promptPath, "utf8")
      const failedFirst = await command(home, ["start", "blocked", "--address", `127.0.0.1:${occupied.port}`, "--detach"])
      expect(failedFirst.code).toBe(1)
      expect(await readFile(statePath, "utf8")).toBe(original)
      expect(await readFile(promptPath, "utf8")).toBe(originalPrompt)
      expect(await runtime(home, "blocked")).toBeNull()

      expect((await command(home, ["start", "blocked", "--detach"])).code).toBe(0)
      const saved = await network(home, "blocked")
      expect((await command(home, ["stop", "blocked"])).code).toBe(0)
      const state = await readFile(statePath, "utf8")
      const prompt = await readFile(promptPath, "utf8")
      const failedOverride = await command(home, ["start", "blocked", "--address", `127.0.0.1:${occupied.port}`, "--detach"])
      expect(failedOverride.code).toBe(1)
      expect(await readFile(statePath, "utf8")).toBe(state)
      expect(await readFile(promptPath, "utf8")).toBe(prompt)

      const taken = Bun.serve({ hostname: saved.bind, port: saved.port, fetch: () => new Response("running") })
      try {
        expect((await command(home, ["start", "blocked", "--detach"])).code).toBe(1)
        expect(await readFile(statePath, "utf8")).toBe(state)
        expect(await readFile(promptPath, "utf8")).toBe(prompt)
        expect(await runtime(home, "blocked")).toBeNull()
      } finally {
        await taken.stop(true)
      }

      expect((await command(home, ["new", "collision"])).code).toBe(0)
      const collision = await command(home, ["start", "collision", "--address", `127.0.0.1:${saved.port}`, "--detach"])
      expect(collision.code).toBe(1)
      expect((await metadata(home, "collision")).network).toBeNull()
      expect(await runtime(home, "collision")).toBeNull()
      expect((await command(home, ["start", "blocked", "--detach"])).code).toBe(0)
      expect(await readFile(statePath, "utf8")).toBe(state)
    } finally {
      await stopIfRunning(home, "blocked")
      await stopIfRunning(home, "collision")
      await occupied.stop(true)
    }
  }, 15_000)

  test("only one concurrent first start can assign an address", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "shared"])).code).toBe(0)
    try {
      const competing = await Promise.all([
        command(home, ["start", "shared", "--detach"]),
        command(home, ["start", "shared", "--detach"]),
      ])
      expect(competing.map((result) => result.code).sort((left, right) => left - right)).toEqual([0, 1])
      const assigned = await network(home, "shared")
      expect(assigned).toEqual({ host: "127.0.0.1", bind: "127.0.0.1", port: assigned.port })
      expect(competing.find((result) => result.code === 0)?.stdout).toContain(`http://127.0.0.1:${assigned.port}/`)
      const statePath = join(home, "shared", "bird.json")
      const promptPath = join(home, "shared", "workspace", "AGENTS.md")
      const state = await readFile(statePath, "utf8")
      const prompt = await readFile(promptPath, "utf8")
      const owner = await runtime(home, "shared")
      expect(owner).not.toBeNull()
      const override = await command(home, ["start", "shared", "--address", "elsewhere.example:0", "--bind", "127.0.0.1", "--detach"])
      expect(override.code).toBe(1)
      expect(await readFile(statePath, "utf8")).toBe(state)
      expect(await readFile(promptPath, "utf8")).toBe(prompt)
      expect(await runtime(home, "shared")).toEqual(owner)
      expect((await command(home, ["list"])).stdout).toContain(`shared\trunning\thttp://127.0.0.1:${assigned.port}/`)
      expect(await events(home, "shared")).toEqual([])
    } finally {
      await stopIfRunning(home, "shared")
    }
  })

  test("concurrent stopped address changes leave only the winning configuration", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "moving"])).code).toBe(0)
    try {
      expect((await command(home, ["start", "moving", "--detach"])).code).toBe(0)
      expect((await post((await network(home, "moving")).port, "Remember me before moving.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "moving")).some((event) => event.kind === "completed"))
      const thread = (await metadata(home, "moving")).threadId
      expect((await command(home, ["stop", "moving"])).code).toBe(0)
      const hosts = ["left.example", "right.example"]
      const results = await Promise.all(hosts.map((host) => command(home,
        ["start", "moving", "--address", `${host}:0`, "--bind", "127.0.0.1", "--detach"],
      )))
      expect(results.map((result) => result.code).sort((left, right) => left - right)).toEqual([0, 1])
      const winner = hosts[results.findIndex((result) => result.code === 0)]
      const loser = hosts[results.findIndex((result) => result.code !== 0)]
      if (winner === undefined || loser === undefined) throw new Error("Expected one winning address")
      const assigned = await network(home, "moving")
      expect(assigned.host).toBe(winner)
      expect((await metadata(home, "moving")).threadId).toBe(thread)
      const prompt = await readFile(join(home, "moving", "workspace", "AGENTS.md"), "utf8")
      expect(prompt).toContain(`your address is http://${winner}:${assigned.port}/.`)
      expect(prompt).not.toContain(`${loser}:`)
      expect((prompt.match(/<!-- birds:runtime -->/g) ?? [])).toHaveLength(1)
      expect((await post(assigned.port, "Continue after the move.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "moving")).filter((event) => event.kind === "completed").length === 2)
      expect((await metadata(home, "moving")).threadId).toBe(thread)
    } finally {
      await stopIfRunning(home, "moving")
    }
  })

  test.each([
    ["127.0.0.1", "127.0.0.1", "127.0.0.1"],
    ["Bird.EXAMPLE", "127.0.0.1", "bird.example"],
    ["[2001:db8::7]", "127.0.0.1", "2001:db8::7"],
    ["Bird.EXAMPLE", "::1", "bird.example"],
  ])("split commands preserve address %s and listener %s through two generations", async (host, bind, normalized) => {
    const home = await makeHome()
    expect((await command(home, ["new", "parent"])).code).toBe(0)
    const childAddress = normalized.includes(":") ? `'[${normalized}]'` : normalized
    const childBind = bind === normalized ? "" : ` --bind ${bind}`
    const bindArgs = bind === normalized ? [] : ["--bind", bind]
    const shell = await Bun.file("/bin/zsh").exists() ? "/bin/zsh" : "/bin/sh"
    try {
      expect((await command(home, ["start", "parent", "--address", host, ...bindArgs, "--detach"], {
        BIRDS_BIND: "192.0.2.1",
      })).code).toBe(0)
      for (const [parent, id] of [["parent", "sprout"], ["sprout", "twig"]] as const) {
        const workspace = join(home, parent, "workspace")
        const prompt = await readFile(join(workspace, "AGENTS.md"), "utf8")
        expect(prompt).toContain(`start <id> --address ${childAddress}${childBind} --detach`)
        expect(prompt).not.toContain("--host")
        expect(prompt).not.toContain("[command]")
        const creation = /`([^`\n]+ new <id>)`/.exec(prompt)?.[1]
        const starting = /`([^`\n]+ start <id>[^`\n]*)`/.exec(prompt)?.[1]
        if (creation === undefined || starting === undefined) throw new Error("Missing child lifecycle commands")

        // zsh rejects unquoted IPv6 brackets as an unmatched glob; exercise the actual instructions.
        for (const instruction of [creation, starting]) {
          const child = Bun.spawn([shell, "-c", instruction.replace("<id>", id)], {
            cwd: workspace,
            env: {
              ...Bun.env,
              BIRDS_HOME: home,
              BIRDS_BIND: parent === "parent" ? undefined : "192.0.2.1",
              HUMMINGBIRDS_PEERS: undefined,
              HUMMINGBIRDS_SEED: undefined,
            },
            stdout: "ignore",
            stderr: "pipe",
          })
          const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
          expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
          if (instruction === creation) expect((await metadata(home, id)).network).toBeNull()
        }
        const child = await network(home, id)
        expect(child).toMatchObject({ host: normalized, bind })
        expect(await events(home, id)).toEqual([])
        const listener = bind.includes(":") ? `[${bind}]` : bind
        expect((await fetch(`http://${listener}:${child.port}/`, {
          method: "POST", body: `Confirm ${id}'s explicitly configured listener.`,
        })).status).toBe(202)
        await waitUntil(async () => (await events(home, id)).some((event) => event.kind === "completed"))
      }
      expect(await readFile(join(home, "twig", "workspace", "AGENTS.md"), "utf8"))
        .toContain(`start <id> --address ${childAddress}${childBind} --detach`)
    } finally {
      await Promise.all(["twig", "sprout", "parent"].map((id) => stopIfRunning(home, id)))
    }
  })

  test.each(["separate", "flat"] as const)("migrates %s legacy session metadata only when starting", async (format) => {
    const home = await makeHome()
    expect((await command(home, ["new", "legacy"])).code).toBe(0)
    const path = join(home, "legacy", "bird.json")
    const threadPath = join(home, "legacy", "thread-id")
    const promptPath = join(home, "legacy", "workspace", "AGENTS.md")
    try {
      expect((await command(home, ["start", "legacy", "--detach"])).code).toBe(0)
      const assigned = await network(home, "legacy")
      const { port } = assigned
      const prompt = await readFile(promptPath, "utf8")
      expect((await post(port, "Remember this conversation before migrating.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "legacy")).some((event) => event.kind === "completed"))
      const thread = (await metadata(home, "legacy")).threadId
      if (thread === null) throw new Error("Expected a persisted conversation")
      expect((await command(home, ["stop", "legacy"])).code).toBe(0)
      const legacy = JSON.stringify(format === "separate"
        ? { id: "legacy", port }
        : { id: "legacy", ...assigned, threadId: thread })
      await writeFile(path, legacy)
      if (format === "separate") await writeFile(threadPath, `${thread}\n`)

      expect((await command(home, ["list"])).stdout).toContain(`legacy\tstopped\thttp://127.0.0.1:${port}/`)
      expect(await readFile(path, "utf8")).toBe(legacy)
      if (format === "separate") expect(await readFile(threadPath, "utf8")).toBe(`${thread}\n`)

      const started = await command(home, ["start", "legacy", "--detach"], {
        BIRDS_BIND: "192.0.2.1",
      })
      expect(started.code).toBe(0)
      expect(started.stdout).toContain(`http://127.0.0.1:${port}/`)
      expect((await metadata(home, "legacy")).threadId).toBe(thread)
      expect(await Bun.file(threadPath).exists()).toBe(false)
      expect((await post(port, "Keep my old state.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "legacy")).filter((event) => event.kind === "completed").length === 2)
      expect(await metadata(home, "legacy")).toEqual({ id: "legacy", network: assigned, threadId: thread })
      expect(await readFile(promptPath, "utf8")).toBe(prompt)
    } finally {
      await stopIfRunning(home, "legacy")
    }
  })

  test("lists and drains a live legacy server without rewriting its configuration", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "legacy"])).code).toBe(0)
    const directory = join(home, "legacy")
    const statePath = join(directory, "bird.json")
    const legacyRunPath = join(directory, "run.json")
    const promptPath = join(directory, "workspace", "AGENTS.md")
    const prompt = await readFile(promptPath, "utf8")
    const token = crypto.randomUUID()
    const actions: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== "/control") return new Response("Not found", { status: 404 })
        if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 })
        if (request.method === "GET") return new Response("running")
        const action = await request.text()
        actions.push(action)
        if (request.method !== "POST" || action !== "stop") return new Response("Send stop.", { status: 400 })
        await Bun.sleep(20)
        await rm(legacyRunPath)
        return new Response("Stopped.")
      },
    })

    try {
      const saved = JSON.stringify({
        id: "legacy", host: "legacy.example", bind: "127.0.0.1", port: server.port, threadId: crypto.randomUUID(),
      })
      const oldRun = JSON.stringify({ pid: process.pid, token })
      await writeFile(statePath, saved)
      await writeFile(legacyRunPath, oldRun)
      const listed = await command(home, ["list"])
      expect(listed.code).toBe(0)
      expect(listed.stdout).toContain(`legacy\trunning\thttp://legacy.example:${server.port}/`)
      const replacement = await command(home, ["start", "legacy", "--address", "changed.example:0", "--bind", "127.0.0.1", "--detach"])
      expect(replacement.code).toBe(1)
      expect(replacement.stderr).toContain("Stop this bird before restarting it with this installation.")
      expect(await readFile(statePath, "utf8")).toBe(saved)
      expect(await readFile(promptPath, "utf8")).toBe(prompt)
      expect(await readFile(legacyRunPath, "utf8")).toBe(oldRun)
      expect(await runtime(home, "legacy")).toBeNull()
      expect(actions).toEqual([])

      expect((await command(home, ["stop", "legacy"])).code).toBe(0)
      expect(actions).toEqual(["stop"])
      expect(await Bun.file(legacyRunPath).exists()).toBe(false)
      expect((await command(home, ["list"])).stdout).toContain("legacy\tstopped\t")
      expect(await readFile(statePath, "utf8")).toBe(saved)
      expect(await readFile(promptPath, "utf8")).toBe(prompt)
    } finally {
      await server.stop(true)
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
      expect(await runtime(home, "invalid")).toBeNull()
      expect(await Bun.file(join(directory, "thread-id")).exists()).toBe(false)
      expect(await events(home, "invalid")).toEqual([])
    }
  })

  test("limits retained bird directories to 99", async () => {
    const home = await makeHome()
    for (let index = 0; index < 99; index++) {
      expect((await command(home, ["new", `bird-${index}`])).code).toBe(0)
    }
    const overflow = await command(home, ["new", "overflow"])
    expect(overflow).toEqual({ code: 1, stderr: "Maximum birds count of 99 reached\n", stdout: "" })
    expect(await readdir(home)).toHaveLength(99)
    expect(await readdir(home)).not.toContain("overflow")
    expect(await Bun.file(join(home, "overflow", "bird.json")).exists()).toBe(false)
  }, 15_000)

  test("never overbooks the concurrent last slot of the 99-directory limit", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "retained"])).code).toBe(0)
    // The cap counts directories, so fill the other retained slots without extra CLI processes.
    for (let index = 0; index < 97; index++) await mkdir(join(home, `retained-${index}`))
    const contenders = await Promise.all([
      command(home, ["new", "last-a"]),
      command(home, ["new", "last-b"]),
    ])
    expect(
      contenders.every((result) => result.code === 0
        || (result.code === 1 && result.stderr === "Maximum birds count of 99 reached\n")),
    ).toBe(true)
    const admitted = contenders.filter((result) => result.code === 0).length
    expect(admitted).toBeLessThanOrEqual(1)
    // Both reservations can see a full root before either rolls back.
    if (admitted === 0) expect((await command(home, ["new", "last-retry"])).code).toBe(0)
    expect(await readdir(home)).toHaveLength(99)
    expect(await command(home, ["new", "overflow"]))
      .toEqual({ code: 1, stderr: "Maximum birds count of 99 reached\n", stdout: "" })
    expect(await readdir(home)).not.toContain("overflow")
    expect((await command(home, ["list"])).stdout).toContain("retained\tstopped\t")
  })

  test("starts in the foreground, rejects duplicates, and resumes on its stable port", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "memory"])).code).toBe(0)
    const foreground = spawn(home, ["start", "memory"])

    try {
      await waitUntil(async () => (await command(home, ["list"])).stdout.includes("memory\trunning\t"))
      const { port } = await network(home, "memory")
      const run = await runtime(home, "memory")
      if (run === null) throw new Error("Missing running server ownership")
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
      expect(restarted.stdout).toContain(`http://127.0.0.1:${port}/`)
      expect((await post(port, "Remember the second message.")).status).toBe(202)
      await waitUntil(async () => {
        return (await events(home, "memory")).filter((event) => event.kind === "completed").length === 2
      })
      expect((await metadata(home, "memory")).threadId).toBe(thread)
      expect(await Bun.file(join(home, "memory", "thread-id")).exists()).toBe(false)

      let output = ""
      const decoder = new TextDecoder()
      const client = Bun.spawn([...cliCommand, "chat", "memory"], {
        env: { ...Bun.env, BIRDS_HOME: home, BIRDS_BIND: undefined },
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
    const { port } = await network(home, "drain")

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
    expect((await command(home, ["start", "stale", "--detach"])).code).toBe(0)
    expect((await command(home, ["stop", "stale"])).code).toBe(0)
    const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stderr: "ignore",
      stdout: "ignore",
    })

    try {
      await writeRuntime(home, "stale", { pid: unrelated.pid, token: crypto.randomUUID(), ready: true })
      expect((await command(home, ["stop", "stale"])).code).not.toBe(0)
      expect(unrelated.exitCode).toBeNull()
    } finally {
      unrelated.kill()
      await unrelated.exited
    }
  })

  test("does not contact a saved old address while its new owner is still starting", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "starting"])).code).toBe(0)
    const statePath = join(home, "starting", "bird.json")
    let requests = 0
    const obsolete = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests += 1
        return new Response("Obsolete endpoint", { status: 409 })
      },
    })
    try {
      const saved = JSON.stringify({
        id: "starting", threadId: null,
        network: { host: "previous.example", bind: "127.0.0.1", port: obsolete.port },
      })
      const owner = { pid: process.pid, token: crypto.randomUUID(), ready: false }
      await writeFile(statePath, saved)
      await writeRuntime(home, "starting", owner)
      expect((await command(home, ["list"])).stdout)
        .toContain(`starting\tstarting\thttp://previous.example:${obsolete.port}/`)
      expect(await command(home, ["stop", "starting"]))
        .toEqual({ code: 1, stdout: "", stderr: "starting is still starting.\n" })
      expect(requests).toBe(0)
      expect(await readFile(statePath, "utf8")).toBe(saved)
      expect(await runtime(home, "starting")).toEqual(owner)
    } finally {
      await obsolete.stop(true)
    }
  })

  test("recovers a dead owner's runtime record and retains its assigned address", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "recover"])).code).toBe(0)
    try {
      expect((await command(home, ["start", "recover", "--detach"])).code).toBe(0)
      const saved = await metadata(home, "recover")
      const promptPath = join(home, "recover", "workspace", "AGENTS.md")
      const prompt = await readFile(promptPath, "utf8")
      expect((await command(home, ["stop", "recover"])).code).toBe(0)
      const exited = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" })
      await exited.exited
      const stale = { pid: exited.pid, token: crypto.randomUUID(), ready: true }
      await writeRuntime(home, "recover", stale)
      expect((await command(home, ["start", "recover", "--detach"])).code).toBe(0)
      expect(await runtime(home, "recover")).not.toEqual(stale)
      expect(await metadata(home, "recover")).toEqual(saved)
      expect(await readFile(promptPath, "utf8")).toBe(prompt)
      expect(await events(home, "recover")).toEqual([])
    } finally {
      await stopIfRunning(home, "recover")
    }
  })

  test("stops without waiting for an unaccepted message upload", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "blocked"])).code).toBe(0)
    expect((await command(home, ["start", "blocked", "--detach"])).code).toBe(0)
    const { port } = await network(home, "blocked")
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
    const parent = await network(home, "parent")
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
      const prompt = await readFile(join(home, "sprout", "workspace", "AGENTS.md"), "utf8")
      expect(prompt).toContain("Your initial peers are:\n(none)")
      expect(prompt).not.toContain("--peer")
      expect(prompt).toContain("After splitting, tell each child about the peers you think are relevant to its work, including their IDs, addresses, and what you know about them.")
      expect(prompt).not.toContain("PARENT-ONLY-FACT-71")
      expect(await metadata(home, "sprout")).toEqual({ id: "sprout", network: null, threadId: null })
      expect(await Bun.file(join(home, "sprout", "thread-id")).exists()).toBe(false)
      expect(await readdir(join(home, "sprout", "workspace"))).toEqual(["AGENTS.md"])
      expect((await command(home, ["start", "sprout", "--detach"])).code).toBe(0)
      const child = await network(home, "sprout")
      expect(await readFile(join(home, "sprout", "workspace", "AGENTS.md"), "utf8"))
        .toContain(`Your ID is sprout, and your address is http://127.0.0.1:${child.port}/.`)

      expect((await command(home, ["new", "twig"])).code).toBe(0)
      const grandchildPrompt = await readFile(join(home, "twig", "workspace", "AGENTS.md"), "utf8")
      expect(grandchildPrompt).toContain("Your initial peers are:\n(none)")
      expect(grandchildPrompt).not.toContain("PARENT-ONLY-FACT-71")
      expect(await metadata(home, "twig")).toEqual({ id: "twig", network: null, threadId: null })
      expect(await Bun.file(join(home, "twig", "thread-id")).exists()).toBe(false)
      expect((await command(home, ["start", "twig", "--detach"])).code).toBe(0)
      const grandchild = await network(home, "twig")

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
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          method: "POST",
          headers: {
            "x-request": requestId,
            "x-reply-to": `http://127.0.0.1:${inbox.port}/`,
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
      BIRDS_BIND: undefined,
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

async function network(home: string, id: string): Promise<Network> {
  const { network } = await metadata(home, id)
  if (network === null) throw new Error(`${id} has not been assigned an address`)
  return network
}

async function runtime(home: string, id: string): Promise<Runtime | null> {
  const directory = join(home, id, "run")
  try {
    const records = await readdir(directory)
    const record = records[0]
    if (records.length !== 1 || record === undefined) throw new Error(`Invalid runtime ownership for ${id}`)
    return JSON.parse(await readFile(join(directory, record), "utf8")) as Runtime
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

async function writeRuntime(home: string, id: string, run: Runtime): Promise<void> {
  const directory = join(home, id, "run")
  await mkdir(directory)
  await writeFile(join(directory, `${run.token}.json`), JSON.stringify(run))
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
  return fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: message })
}

async function stalledPost(port: number, message: string) {
  const abort = new AbortController()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()
  const response = fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    body: stream.readable,
    signal: abort.signal,
  }).catch(() => null)
  await writer.write(new TextEncoder().encode(message))
  return { response, complete: () => writer.close(), cancel: () => abort.abort() }
}

async function stopIfRunning(home: string, id: string): Promise<void> {
  if (await runtime(home, id) !== null) await command(home, ["stop", id])
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error("Condition timed out")
    await Bun.sleep(10)
  }
}
