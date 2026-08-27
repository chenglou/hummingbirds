#!/usr/bin/env bun
import { existsSync, readdirSync } from "fs"
import { join } from "path"
import { parseArgs } from "util"
import { chat } from "./chat.ts"
import {
  birdDirectory,
  birdHome,
  birdStatus,
  createBird,
  readBird,
  startBird,
  stopBird,
} from "./local.ts"

const usage = `Usage:
  birds new <id> [--port N] [--peer <local-id> ...]
  birds start <id> [--detach]
  birds chat <id | port | host:port | URL>
  birds stop <id>
  birds list

Birds live in ~/.birds (override with BIRDS_HOME).
Start stays in the foreground unless --detach is given.
Stop drains accepted work and preserves memory.`

const [command, ...args] = process.argv.slice(2)

try {
  if (command === undefined || command === "help" || command === "--help" || args.includes("--help")) {
    console.log(usage)
  } else {
    switch (command) {
      case "new": {
        const { positionals, values } = parseArgs({
          args,
          allowPositionals: true,
          options: { port: { type: "string" }, peer: { type: "string", multiple: true } },
        })
        const id = oneArgument(positionals)
        const peers = values.peer === undefined
          ? (Bun.env["HUMMINGBIRDS_PEERS"] ?? "(none)")
          : values.peer.map((name) => {
            const peer = readBird(birdDirectory(name))
            return `- ${peer.id} at http://127.0.0.1:${peer.port}/ask`
          }).join("\n")
        if (values.port !== undefined && !/^\d+$/.test(values.port)) {
          throw new Error("Port must be an integer from 0 to 65535.")
        }
        await createBird(birdDirectory(id), id, {
          port: Number(values.port ?? 0),
          peers,
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
            console.log(`Started ${bird.id} at http://127.0.0.1:${bird.port}/ask.`)
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
          await chat(`http://127.0.0.1:${bird.port}`)
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
          return `${bird.id}\t${await birdStatus(bird)}\thttp://127.0.0.1:${bird.port}/ask`
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
