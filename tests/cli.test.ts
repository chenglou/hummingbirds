import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"

type Result = { code: number; stderr: string; stdout: string }
type Event = { kind: string }

const executable = resolve("src/cli.ts")
const fakeCodex = resolve("tests/fake-codex.ts")
const homes: string[] = []

afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { force: true, recursive: true })))
})

describe("birds", () => {
  test("creates separate stopped birds, resolves local peers, and isolates homes", async () => {
    const home = await makeHome()
    const first = await command(home, ["new", "b"], { HUMMINGBIRDS_SEED: "B-ONLY-FACT-71" })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("Created b.")

    const second = await command(home, ["new", "a", "--peer", "b"])
    expect(second.code).toBe(0)
    const a = await metadata(home, "a")
    const b = await metadata(home, "b")
    expect(a.port).not.toBe(b.port)
    expect(await Bun.file(join(home, "a", "run.json")).exists()).toBe(false)
    expect(await Bun.file(join(home, "b", "run.json")).exists()).toBe(false)
    expect(await readFile(join(home, "a", "workspace", "AGENTS.md"), "utf8")).toContain(
      `- b at http://127.0.0.1:${b.port}/ask`,
    )
    expect(await readFile(join(home, "b", "workspace", "AGENTS.md"), "utf8")).toContain(
      "B-ONLY-FACT-71",
    )

    const listed = await command(home, ["list"])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain(`a\tstopped\thttp://127.0.0.1:${a.port}/ask`)
    expect(listed.stdout).toContain(`b\tstopped\thttp://127.0.0.1:${b.port}/ask`)
    expect((await command(home, ["new", "a"])).code).not.toBe(0)
    expect((await command(home, ["new", "../escaped"])).code).not.toBe(0)

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
    expect(help.stdout).not.toContain("birds kill")
    const removed = await command(home, ["kill", "a"])
    expect(removed.code).not.toBe(0)
    expect(removed.stderr).toContain("Unknown command: kill")
    expect((await command(home, ["chat"])).code).not.toBe(0)
  }, 15_000)

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
      const thread = await readFile(join(home, "memory", "thread-id"), "utf8")

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
      expect(await readFile(join(home, "memory", "thread-id"), "utf8")).toBe(thread)

      let output = ""
      const decoder = new TextDecoder()
      const client = Bun.spawn([process.execPath, executable, "chat", "memory"], {
        env: { ...Bun.env, BIRDS_HOME: home, HUMMINGBIRDS_CODEX: fakeCodex },
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

      const late = await stalledPost(port, "/ask", "This upload started before shutdown.")
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

  test("stops without waiting for an unaccepted hatch upload", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "blocked"])).code).toBe(0)
    expect((await command(home, ["start", "blocked", "--detach"])).code).toBe(0)
    const { port } = await metadata(home, "blocked")
    let unfinished: Awaited<ReturnType<typeof stalledPost>> | null = null

    try {
      unfinished = await stalledPost(port, "/hatch", "unborn")
      const hatchStop = performance.now()
      expect((await command(home, ["stop", "blocked"])).code).toBe(0)
      expect(performance.now() - hatchStop).toBeLessThan(2_000)
      expect(await readdir(home)).not.toContain("unborn")
      expect(await Bun.file(join(home, "blocked", "bird.json")).exists()).toBe(true)
    } finally {
      if (unfinished !== null) {
        unfinished.cancel()
        await unfinished.response
      }
      await stopIfRunning(home, "blocked")
    }
  }, 20_000)

  test("lists hatched children and keeps them alive after their parent stops", async () => {
    const home = await makeHome()
    expect((await command(home, ["new", "parent"])).code).toBe(0)
    expect((await command(home, ["start", "parent", "--detach"])).code).toBe(0)
    const { port } = await metadata(home, "parent")

    try {
      const hatched = await fetch(`http://127.0.0.1:${port}/hatch`, { method: "POST", body: "child" })
      expect(hatched.status).toBe(201)
      const listed = await command(home, ["list"])
      expect(listed.stdout).toContain("parent\trunning\t")
      expect(listed.stdout).toContain("child\trunning\t")

      expect((await command(home, ["stop", "parent"])).code).toBe(0)
      const { port: childPort } = await metadata(home, "child")
      expect((await post(childPort, "Still independent.")).status).toBe(202)
      await waitUntil(async () => (await events(home, "child")).some((event) => event.kind === "completed"))
      expect((await command(home, ["list"])).stdout).toContain("child\trunning\t")
    } finally {
      await stopIfRunning(home, "child")
      await stopIfRunning(home, "parent")
    }
  }, 20_000)
})

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hummingbirds-cli-"))
  homes.push(home)
  return home
}

function spawn(home: string, args: string[], environment: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, executable, ...args], {
    env: { ...Bun.env, BIRDS_HOME: home, HUMMINGBIRDS_CODEX: fakeCodex, ...environment },
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

async function metadata(home: string, id: string): Promise<{ id: string; port: number }> {
  return JSON.parse(await readFile(join(home, id, "bird.json"), "utf8")) as { id: string; port: number }
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

async function stalledPost(port: number, path: string, message: string) {
  const abort = new AbortController()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()
  const response = fetch(`http://127.0.0.1:${port}${path}`, {
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
