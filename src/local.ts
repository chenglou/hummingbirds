import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "fs"
import { devNull, homedir } from "os"
import { dirname, join, resolve } from "path"
import { hostPort, httpOrigin, localOrigin, networkSettings, type Network } from "./network.ts"

export type Bird = { id: string; directory: string; network: Network | null; threadId: string | null }

type Options = { peers?: string; seed?: string }
type Run = { pid: number; token: string; ready: boolean }

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
    network?: Network | null
    port?: number
    host?: string
    bind?: string
    threadId?: string | null
  }
  birdDirectory(bird.id, dirname(directory))
  const saved = bird.network === undefined && bird.port !== undefined
    ? { host: bird.host ?? "127.0.0.1", port: bird.port, bind: bird.bind }
    : bird.network
  const network = saved == null ? null : networkSettings(hostPort(saved.host, saved.port), saved.bind)
  if (network !== null && network.port === 0) {
    throw new Error("Bird port must be between 1 and 65535.")
  }
  const threadId = bird.threadId ?? null
  // Invalid saved memory must never silently become a fresh conversation.
  if (threadId !== null && (typeof threadId !== "string" || threadId.trim() === "")) {
    throw new Error("Bird threadId must be a non-empty string or null.")
  }
  return { id: bird.id, network, directory, threadId }
}

export function writeBird({ directory, ...metadata }: Bird): void {
  const path = join(directory, "bird.json")
  writeFileSync(`${path}.tmp`, JSON.stringify(metadata))
  renameSync(`${path}.tmp`, path)
}

export async function createBird(directory: string, id: string, options: Options = {}): Promise<Bird> {
  const root = dirname(directory)
  birdDirectory(id, root)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  mkdirSync(directory, { mode: 0o700 })

  const count = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
  if (count > 99) {
    rmdirSync(directory)
    throw new Error("Maximum birds count of 99 reached")
  }

  const workspace = join(directory, "workspace")
  mkdirSync(workspace, { mode: 0o700 })
  const prompt = readFileSync(join(import.meta.dir, "prompt_template.md"), "utf8")
  await Bun.write(join(workspace, "AGENTS.md"), prompt
    .replaceAll("[id]", id)
    .replaceAll("[peers]", options.peers ?? "(none)")
    .replaceAll("[seed]", options.seed ?? "(none)"))
  const bird: Bird = { id, directory, network: null, threadId: null }
  writeBird(bird)
  return bird
}

export function updatePrompt(bird: Bird, network: Network): void {
  const section = /<!-- birds:runtime -->[\s\S]*?<!-- \/birds:runtime -->/
  const template = readFileSync(join(import.meta.dir, "prompt_template.md"), "utf8").match(section)?.[0]
  if (template === undefined) throw new Error("Prompt template is missing its runtime section.")
  // Codex 0.149.1 misses command rules when the executable is unnecessarily quoted.
  const command = cliCommand.map(shellArgument).join(" ")
  const runtime = template
    .replaceAll("[id]", bird.id)
    .replaceAll("[address]", `${httpOrigin(network.host, network.port)}/`)
    .replaceAll("[child-address]", shellArgument(hostPort(network.host)))
    .replaceAll("[bind-option]", network.bind === network.host ? "" : ` --bind ${shellArgument(network.bind)}`)
    .replaceAll("[command]", command)
  const path = join(bird.directory, "workspace", "AGENTS.md")
  const current = readFileSync(path, "utf8")
  let next: string
  if (section.test(current)) {
    next = current.replace(section, () => runtime)
  } else {
    // Upgrade only the generated lines in older prompts; keep everything else.
    const identity = /^Your ID is [^\n]+, and your address is [^\n]+\.$/m
    if (!identity.test(current)) throw new Error("AGENTS.md is missing its generated identity section.")
    next = current.replace(identity, () => runtime)
      .replace(/^- You can create another independent bird with [^\n]*\n/m, "")
  }
  if (next !== current) {
    writeFileSync(`${path}.tmp`, next)
    renameSync(`${path}.tmp`, path)
  }
}

function shellArgument(value: string): string {
  return /^[\w./=:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

export async function startBird(
  bird: Bird,
  detached: boolean,
  options: { address?: string; bind?: string } = {},
): Promise<Bun.Subprocess> {
  if (options.address !== undefined || options.bind !== undefined) networkSettings(options.address, options.bind)
  const args = [
    ...(options.address === undefined ? [] : ["--address", options.address]),
    ...(options.bind === undefined ? [] : ["--bind", options.bind]),
  ]
  const outputPath = join(bird.directory, "stdout.jsonl")
  const output = detached ? openSync(outputPath, "a") : undefined
  const outputOffset = output === undefined ? 0 : fstatSync(output).size
  const child = Bun.spawn([...bunCommand, require.resolve("./server.ts"), ...args], {
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
    if (run?.pid === child.pid && run.ready && (await birdStatus(readBird(bird.directory))) === "running") return child
    if (child.exitCode !== null || child.signalCode !== null) {
      let message = "Bird exited before starting."
      if (detached) {
        const diagnostic = Bun.stripANSI(await Bun.file(outputPath).slice(outputOffset, outputOffset + 16_384).text())
        message = /^error: (.+)$/m.exec(diagnostic)?.[1] ?? `${message} See ${outputPath}.`
      }
      throw new Error(message)
    }
    await Bun.sleep(10)
  }
  child.kill()
  await child.exited
  throw new Error("Bird did not start in time.")
}

export async function birdStatus(bird: Bird): Promise<"stopped" | "starting" | "unreachable" | "running" | "stopping"> {
  const run = readRun(bird.directory)
  if (run === null) return "stopped"
  if (!run.ready || bird.network === null) return "starting"
  const response = await fetch(`${localOrigin(bird.network)}/control`, {
    headers: { authorization: `Bearer ${run.token}` },
    signal: AbortSignal.timeout(500),
  }).catch(() => null)
  if (response === null || !response.ok) return "unreachable"
  const status = await response.text()
  return status === "running" || status === "stopping" ? status : "unreachable"
}

export async function stopBird(bird: Bird): Promise<void> {
  const run = readRun(bird.directory)
  if (run === null) return
  if (!run.ready || bird.network === null) throw new Error(`${bird.id} is still starting.`)
  const response = await fetch(`${localOrigin(bird.network)}/control`, {
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
    const path = join(directory, "run")
    const files = readdirSync(path)
    if (files.length === 0) return null
    const file = files[0]
    if (files.length !== 1 || file === undefined) throw new Error("Invalid bird runtime directory.")
    const run = JSON.parse(readFileSync(join(path, file), "utf8")) as Run
    if (file !== `${run.token}.json` || !Number.isSafeInteger(run.pid) || run.pid < 1) {
      throw new Error("Invalid bird runtime record.")
    }
    return run
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
    // An older running installation still owns this record until its /control stop finishes.
    try {
      const legacy = JSON.parse(readFileSync(join(directory, "run.json"), "utf8")) as Run
      return { ...legacy, ready: true }
    } catch (legacyError) {
      if (legacyError instanceof Error && "code" in legacyError && legacyError.code === "ENOENT") return null
      throw legacyError
    }
  }
}

export function claimRun(directory: string, token: string): { ready: () => void; release: () => void } {
  if (existsSync(join(directory, "run.json"))) {
    throw new Error("Stop this bird before restarting it with this installation.")
  }
  const path = join(directory, "run")
  const candidate = join(directory, `.run-${token}`)
  mkdirSync(candidate, { mode: 0o700 })
  try {
    const record: Run = { pid: process.pid, token, ready: false }
    writeFileSync(join(candidate, `${token}.json`), JSON.stringify(record), { mode: 0o600 })
    while (true) {
      try {
        // Publishing a complete, nonempty directory is atomic. Only one server wins.
        renameSync(candidate, path)
        return {
          ready: () => {
            const temporary = join(directory, `.run-${token}.tmp`)
            writeFileSync(temporary, JSON.stringify({ ...record, ready: true }), { mode: 0o600 })
            renameSync(temporary, join(path, `${token}.json`))
          },
          release: () => releaseRun(path, token),
        }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error)
          || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) throw error
      }
      const previous = readRun(directory)
      if (previous === null) continue
      try {
        process.kill(previous.pid, 0)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
          releaseRun(path, previous.token)
          continue
        }
        throw error
      }
      throw new Error("Bird is already running or starting.")
    }
  } finally {
    releaseRun(candidate, token)
  }
}

function releaseRun(path: string, token: string): void {
  try {
    // Never unlink a successor's record when reclaiming a crashed server's directory.
    unlinkSync(join(path, `${token}.json`))
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
  try {
    rmdirSync(path)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)
      || (error.code !== "ENOENT" && error.code !== "ENOTEMPTY")) throw error
  }
}
