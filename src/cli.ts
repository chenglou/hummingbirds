import { resolve } from "node:path"

import { askNetwork, readTrace, startNetwork, stopNetwork } from "./harness.ts"

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function main(arguments_: string[]): Promise<void> {
  const command = arguments_[0]
  switch (command) {
    case "run":
      await run(arguments_)
      return
    case "inspect":
      await inspect(arguments_)
      return
    default:
      throw new Error(usage())
  }
}

async function run(arguments_: string[]): Promise<void> {
  const scenarioPath = arguments_[1]
  const questions = arguments_.slice(2)
  if (scenarioPath === undefined || questions.length === 0) throw new Error(usage())

  const suffix = `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID().slice(0, 8)}`
  const runDirectory = resolve("logs", suffix)
  const network = await startNetwork(scenarioPath, runDirectory)
  try {
    for (const [index, question] of questions.entries()) {
      const result = await askNetwork(network, question)
      if (index > 0) process.stdout.write("\n\n")
      process.stdout.write(result.answer)
      console.error(`request: ${result.requestId}`)
      if (result.status < 200 || result.status >= 300) process.exitCode = 1
    }
    console.error(`run: ${runDirectory}`)
  } finally {
    await stopNetwork(network)
  }
}

async function inspect(arguments_: string[]): Promise<void> {
  const runDirectory = arguments_[1]
  const requestId = arguments_[2] ?? null
  if (runDirectory === undefined || arguments_.length > 3) throw new Error(usage())
  console.log(JSON.stringify(await readTrace(runDirectory, requestId), null, 2))
}

function usage(): string {
  return [
    "Usage:",
    '  bun run hummingbirds run <scenario.json> "<question>" ["<next-question>" ...]',
    "  bun run hummingbirds inspect <run-directory> [request-id]",
  ].join("\n")
}
