import { resolve } from "path"

import { askNetwork, readTrace, startNetwork, stopNetwork } from "./harness.ts"

const [command, ...args] = process.argv.slice(2)
try {
  if (command === "run" && args.length >= 2) await run(args[0] ?? "", args.slice(1))
  else if (command === "inspect" && args.length >= 1) await inspect(args[0] ?? "", args[1] ?? null)
  else throw new Error(usage())
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function run(scenarioPath: string, questions: string[]): Promise<void> {
  const directory = resolve("logs", new Date().toISOString().replaceAll(":", "-"))
  const network = await startNetwork(scenarioPath, directory)
  try {
    for (const [index, question] of questions.entries()) {
      const requestId = crypto.randomUUID()
      const result = await askNetwork(network, question, requestId)
      if (index > 0) process.stdout.write("\n\n")
      process.stdout.write(result.answer)
      console.error(`request: ${requestId}`)
      if (result.status !== 200) process.exitCode = 1
    }
    console.error(`run: ${directory}`)
  } finally {
    await stopNetwork(network)
  }
}

async function inspect(directory: string, requestId: string | null): Promise<void> {
  console.log(JSON.stringify(await readTrace(directory, requestId), null, 2))
}

function usage(): string {
  return [
    "Usage:",
    '  bun run experiment:local-flock run <scenario.json> "<question>" ["<next-question>" ...]',
    "  bun run experiment:local-flock inspect <run-directory> [request-id]",
  ].join("\n")
}
