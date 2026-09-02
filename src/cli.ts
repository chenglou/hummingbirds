#!/usr/bin/env bun
import { existsSync, readdirSync } from "fs"
import { join } from "path"
import { parseArgs } from "util"
import { chat } from "./chat.ts"
import {
  birdDirectory,
  birdHome,
  birdStatus,
  codexCommand,
  createBird,
  readBird,
  startBird,
  stopBird,
} from "./local.ts"
import { httpOrigin, localOrigin, networkSettings } from "./network.ts"

const usage = `Usage:
  birds login [--device-auth]
  birds new <id> [--host IP-or-hostname] [--port N]
  birds start <id> [--detach]
  birds chat <id | port | host:port | URL>
  birds stop <id>
  birds list

Birds live in ~/.birds (override with BIRDS_HOME).
Use new --host for this machine's reachable IP or hostname (default: 127.0.0.1).
BIRDS_BIND overrides the listening interface; both are saved by new.
Chat receives replies through the bird's server; no local listening port is needed.
Start stays in the foreground unless --detach is given.
Stop drains accepted work and preserves memory.`

const [command, ...args] = process.argv.slice(2)

try {
  if (command === undefined || command === "help" || command === "--help"
    || (command !== "login" && args.includes("--help"))) {
    console.log(usage)
  } else {
    switch (command) {
      case "login": {
        const child = Bun.spawn([...codexCommand, "login", ...args], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        })
        const interrupt = () => child.kill("SIGTERM")
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
        for (const signal of signals) process.on(signal, interrupt)
        try {
          process.exitCode = await child.exited
        } finally {
          for (const signal of signals) process.off(signal, interrupt)
        }
        break
      }
      case "new": {
        const { positionals, values } = parseArgs({
          args,
          allowPositionals: true,
          options: { host: { type: "string" }, port: { type: "string" } },
        })
        const id = oneArgument(positionals)
        await createBird(birdDirectory(id), id, {
          port: portOption(values.port),
          ...networkSettings(values.host, Bun.env["BIRDS_BIND"]),
          peers: Bun.env["HUMMINGBIRDS_PEERS"] ?? "(none)",
          seed: Bun.env["HUMMINGBIRDS_SEED"] ?? "(none)",
        })
        console.log(`Created ${id}. Start it with birds start ${id}.`)
        break
      }
      case "start": {
        const { positionals, values } = parseArgs({
          args,
          allowPositionals: true,
          options: { detach: { type: "boolean" } },
        })
        const bird = readBird(birdDirectory(oneArgument(positionals)))
        const state: { child: Bun.Subprocess | null; interrupted: boolean } = {
          child: null,
          interrupted: false,
        }
        const interrupt = () => {
          state.interrupted = true
          if (state.child !== null) state.child.kill("SIGTERM")
        }
        process.on("SIGINT", interrupt)
        process.on("SIGTERM", interrupt)
        process.on("SIGHUP", interrupt)
        try {
          const child = await startBird(bird, values.detach === true)
          state.child = child
          if (state.interrupted) child.kill("SIGTERM")
          if (values.detach === true && !state.interrupted) {
            console.log(`Started ${bird.id} at ${httpOrigin(bird.host, bird.port)}/.`)
          } else {
            process.exitCode = await child.exited
          }
        } finally {
          process.off("SIGINT", interrupt)
          process.off("SIGTERM", interrupt)
          process.off("SIGHUP", interrupt)
        }
        break
      }
      case "chat": {
        const target = oneArgument(args)
        if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target)
          && existsSync(join(birdDirectory(target), "bird.json"))) {
          const bird = readBird(birdDirectory(target))
          const status = await birdStatus(bird)
          if (status !== "running") throw new Error(`${bird.id} is ${status}. Start it with birds start ${bird.id}.`)
          await chat(localOrigin(bird))
        } else if (/^\d+$/.test(target) || target.includes(":") || target.includes(".")) {
          await chat(target)
        } else {
          throw new Error(`Unknown local bird: ${target}. Use birds list.`)
        }
        break
      }
      case "stop": {
        const bird = readBird(birdDirectory(oneArgument(args)))
        await stopBird(bird)
        console.log(`Stopped ${bird.id}.`)
        break
      }
      case "list": {
        if (args.length !== 0) throw new Error("Usage: birds list")
        const root = birdHome()
        const entries = existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []
        const birds = entries
          .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "bird.json")))
          .map((entry) => readBird(join(root, entry.name)))
          .sort((a, b) => a.id.localeCompare(b.id))
        const rows = await Promise.all(birds.map(async (bird) => {
          return `${bird.id}\t${await birdStatus(bird)}\t${httpOrigin(bird.host, bird.port)}/`
        }))
        console.log(["ID\tSTATUS\tADDRESS", ...rows].join("\n"))
        break
      }
      default:
        throw new Error(`Unknown command: ${command}\n${usage}`)
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

function oneArgument(args: string[]): string {
  const value = args[0]
  if (args.length !== 1 || value === undefined || value.startsWith("-")) throw new Error(usage)
  return value
}

function portOption(value: string | undefined): number {
  const port = Number(value ?? 0)
  if ((value !== undefined && !/^\d+$/.test(value)) || !Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("Port must be an integer from 0 to 65535.")
  }
  return port
}
