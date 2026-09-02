import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "fs"
import { devNull, homedir } from "os"
import { dirname, join, resolve } from "path"
import { httpOrigin, localOrigin, networkSettings, type Network } from "./network.ts"

export type Bird = Network & { id: string; directory: string; port: number; threadId: string | null }

type Options = Partial<Network> & { port?: number; peers?: string; seed?: string }
type Run = { pid: number; token: string }

// Trusted bootstraps must not load a bird's writable Bun config or environment files.
const bunCommand = [process.execPath, "--no-env-file", `--config=${devNull}`]

// Pin both the interpreter and installation, not a bird's writable working directory.
export const cliCommand = [
  ...bunCommand,
  `--cwd=${import.meta.dir}`,
  require.resolve("./cli.ts"),
]

export const codexCommand = [...bunCommand, require.resolve("@openai/codex/bin/codex.js")]

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
    host?: string
    bind?: string
    threadId?: string | null
  }
  birdDirectory(bird.id, dirname(directory))
  if (!Number.isSafeInteger(bird.port) || bird.port < 1 || bird.port > 65_535) {
    throw new Error("Bird port must be between 1 and 65535.")
  }
  const threadId = bird.threadId ?? null
  // Invalid saved memory must never silently become a fresh conversation.
  if (threadId !== null && (typeof threadId !== "string" || threadId.trim() === "")) {
    throw new Error("Bird threadId must be a non-empty string or null.")
  }
  return { ...bird, ...networkSettings(bird.host, bird.bind), directory, threadId }
}

export function writeBird({ directory, ...metadata }: Bird): void {
  const path = join(directory, "bird.json")
  writeFileSync(`${path}.tmp`, JSON.stringify(metadata))
  renameSync(`${path}.tmp`, path)
}

export async function createBird(directory: string, id: string, options: Options = {}): Promise<Bird> {
  const root = dirname(directory)
  birdDirectory(id, root)
  const network = networkSettings(options.host, options.bind)
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)) {
    throw new Error("Bird port must be between 0 and 65535.")
  }
  const maxBirds = Number(Bun.env["HUMMINGBIRDS_MAX_BIRDS"] ?? 32)
  if (!Number.isSafeInteger(maxBirds) || maxBirds < 1) {
    throw new Error("HUMMINGBIRDS_MAX_BIRDS must be a positive integer.")
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  mkdirSync(directory, { mode: 0o700 })

  const count = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
  if (count > maxBirds) {
    rmdirSync(directory)
    throw new Error("Local bird limit reached.")
  }

  const requested = options.port ?? 0
  let reservation: ReturnType<typeof Bun.serve>
  try {
    reservation = Bun.serve({ hostname: network.bind, port: requested, fetch: () => new Response() })
    while (reservation.port !== undefined && readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "bird.json")))
      .some((entry) => readBird(join(root, entry.name)).port === reservation.port)) {
      await reservation.stop(true)
      if (requested !== 0) throw new Error(`Bird port ${requested} is already assigned.`)
      reservation = Bun.serve({ hostname: network.bind, port: requested, fetch: () => new Response() })
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
    // Codex 0.149.1 misses command rules when the executable is unnecessarily quoted.
    const command = cliCommand
      .map((arg) => /^[\w./=:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)
      .join(" ")
    await Bun.write(
      join(workspace, "AGENTS.md"),
      prompt
        .replaceAll("[id]", id)
        .replaceAll("[address]", `${httpOrigin(network.host, port)}/ask`)
        .replaceAll("[command]", command)
        .replaceAll("[peers]", options.peers ?? "(none)")
        .replaceAll("[seed]", options.seed ?? "(none)"),
    )
    const bird = { id, directory, port, ...network, threadId: null }
    writeBird(bird)
    return bird
  } finally {
    await reservation.stop(true)
  }
}

export async function startBird(bird: Bird, detached: boolean): Promise<Bun.Subprocess> {
  const output = detached ? openSync(join(bird.directory, "stdout.jsonl"), "a") : undefined
  const child = Bun.spawn([...bunCommand, require.resolve("./server.ts")], {
    cwd: bird.directory,
    detached: true,
    env: {
      ...process.env,
      HUMMINGBIRDS_DIRECTORY: bird.directory,
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
  const response = await fetch(`${localOrigin(bird)}/control`, {
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
  const response = await fetch(`${localOrigin(bird)}/control`, {
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
