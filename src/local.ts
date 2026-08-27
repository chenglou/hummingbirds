import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, join, resolve } from "path"

export type Bird = { id: string; directory: string; port: number }

type Options = { port?: number; peers?: string; seed?: string; maxBirds?: number }
type Run = { pid: number; token: string }

const executable = Bun.env["HUMMINGBIRDS_CODEX"]
export const codexCommand = executable === undefined
  ? [process.execPath, require.resolve("@openai/codex/bin/codex.js")]
  : [executable]

export function birdHome(): string {
  return resolve(Bun.env["BIRDS_HOME"] ?? join(homedir(), ".birds"))
}

export function birdDirectory(id: string, root: string = birdHome()): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new Error("Bird ID must contain only letters, numbers, underscores, or hyphens.")
  }
  return join(root, id)
}

export function readBird(directory: string): Bird {
  const bird = JSON.parse(readFileSync(join(directory, "bird.json"), "utf8")) as {
    id: string
    port: number
  }
  birdDirectory(bird.id, dirname(directory))
  if (!Number.isSafeInteger(bird.port) || bird.port < 1 || bird.port > 65_535) {
    throw new Error("Bird port must be between 1 and 65535.")
  }
  return { ...bird, directory }
}

export async function createBird(directory: string, id: string, options: Options = {}): Promise<Bird> {
  const root = dirname(directory)
  birdDirectory(id, root)
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)) {
    throw new Error("Bird port must be between 0 and 65535.")
  }
  if (options.maxBirds !== undefined && (!Number.isSafeInteger(options.maxBirds) || options.maxBirds < 1)) {
    throw new Error("Local bird limit must be a positive integer.")
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  mkdirSync(directory, { mode: 0o700 })

  if (options.maxBirds !== undefined) {
    const count = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    if (count > options.maxBirds) {
      rmdirSync(directory)
      throw new Error("Local bird limit reached.")
    }
  }

  const requested = options.port ?? 0
  let reservation: ReturnType<typeof Bun.serve>
  try {
    reservation = Bun.serve({ hostname: "127.0.0.1", port: requested, fetch: () => new Response() })
    while (reservation.port !== undefined && readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "bird.json")))
      .some((entry) => readBird(join(root, entry.name)).port === reservation.port)) {
      await reservation.stop(true)
      if (requested !== 0) throw new Error(`Bird port ${requested} is already assigned.`)
      reservation = Bun.serve({ hostname: "127.0.0.1", port: requested, fetch: () => new Response() })
    }
  } catch (error) {
    rmdirSync(directory)
    throw error
  }
  const port = reservation.port
  if (port === undefined) throw new Error("Could not reserve a bird port.")

  try {
    const workspace = join(directory, "workspace")
    mkdirSync(workspace, { mode: 0o700 })
    const prompt = readFileSync(join(import.meta.dir, "prompt_template.md"), "utf8")
    await Bun.write(
      join(workspace, "AGENTS.md"),
      prompt
        .replaceAll("[id]", id)
        .replaceAll("[address]", `http://127.0.0.1:${port}/ask`)
        .replaceAll("[peers]", options.peers ?? "(none)")
        .replaceAll("[seed]", options.seed ?? "(none)"),
    )
    const metadata = join(directory, "bird.json")
    writeFileSync(`${metadata}.tmp`, JSON.stringify({ id, port }))
    renameSync(`${metadata}.tmp`, metadata)
    return { id, directory, port }
  } finally {
    await reservation.stop(true)
  }
}

export async function startBird(bird: Bird, detached: boolean): Promise<Bun.Subprocess> {
  const output = detached ? openSync(join(bird.directory, "stdout.jsonl"), "a") : undefined
  const child = Bun.spawn([process.execPath, require.resolve("./server.ts")], {
    cwd: bird.directory,
    detached: true,
    env: {
      ...process.env,
      HUMMINGBIRDS_DIRECTORY: bird.directory,
      HUMMINGBIRDS_PEERS: undefined,
      HUMMINGBIRDS_SEED: undefined,
    },
    stdin: "ignore",
    stdout: output ?? "inherit",
    stderr: output ?? "inherit",
  })
  if (output !== undefined) closeSync(output)
  if (detached) child.unref()

  for (let attempt = 0; attempt < 500; attempt += 1) {
    const run = readRun(bird.directory)
    if (run?.pid === child.pid && (await birdStatus(bird)) === "running") return child
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Bird exited before starting.")
    }
    await Bun.sleep(10)
  }
  child.kill()
  await child.exited
  throw new Error("Bird did not start in time.")
}

export async function birdStatus(bird: Bird): Promise<"stopped" | "unreachable" | "running" | "stopping"> {
  const run = readRun(bird.directory)
  if (run === null) return "stopped"
  const response = await fetch(`http://127.0.0.1:${bird.port}/control`, {
    headers: { authorization: `Bearer ${run.token}` },
    signal: AbortSignal.timeout(500),
  }).catch(() => null)
  if (response === null || !response.ok) return "unreachable"
  const status = await response.text()
  return status === "stopping" ? "stopping" : "running"
}

export async function stopBird(bird: Bird): Promise<void> {
  const run = readRun(bird.directory)
  if (run === null) return
  const response = await fetch(`http://127.0.0.1:${bird.port}/control`, {
    method: "POST",
    headers: { authorization: `Bearer ${run.token}` },
    body: "stop",
  })
  if (!response.ok) throw new Error(await response.text())
  while (true) {
    const current = readRun(bird.directory)
    if (current === null) return
    if (current.token !== run.token) throw new Error("Bird process changed while stopping.")
    const status = await birdStatus(bird)
    if (status === "stopped") return
    if (status === "unreachable") {
      if (readRun(bird.directory) === null) return
      throw new Error("Bird became unreachable while stopping.")
    }
    await Bun.sleep(10)
  }
}

function readRun(directory: string): Run | null {
  try {
    return JSON.parse(readFileSync(join(directory, "run.json"), "utf8")) as Run
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}
