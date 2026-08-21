import { resolve } from "path"

import {
  askNetwork,
  askNetworkAsync,
  readTrace,
  startInbox,
  startNetwork,
  stopNetwork,
  type Network,
} from "./harness.ts"

const [command, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((arg) => arg.startsWith("--")))
const args = rest.filter((arg) => !arg.startsWith("--"))
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
    if (flags.has("--async")) await runAsync(network, questions, flags.has("--concurrent"))
    else await runSync(network, questions)
    console.error(`run: ${directory}`)
  } finally {
    await stopNetwork(network)
  }
}

// Wait on the line for each answer, one question after another.
async function runSync(network: Network, questions: string[]): Promise<void> {
  for (const [index, question] of questions.entries()) {
    const requestId = shortId()
    const result = await askNetwork(network, question, requestId)
    if (index > 0) process.stdout.write("\n\n")
    process.stdout.write(result.answer)
    console.error(`request: ${requestId}`)
    if (result.status !== 200) process.exitCode = 1
  }
}

// Hand the birds an inbox address instead; with --concurrent, fire every question
// at once and let the flock sort it out.
async function runAsync(network: Network, questions: string[], concurrent: boolean): Promise<void> {
  const inbox = startInbox()
  try {
    const ask = async (question: string): Promise<void> => {
      const requestId = shortId()
      console.error(`request: ${requestId}`)
      const result = await askNetworkAsync(network, inbox, question, requestId)
      if (result.status !== 202 || result.replies.length === 0) process.exitCode = 1
      if (result.replies.length === 0) console.error(`no reply for ${requestId}`)
      for (const message of result.replies) {
        process.stdout.write(`[${requestId}] from ${message.from}:\n${message.body}\n\n`)
      }
    }
    if (concurrent) await Promise.all(questions.map(ask))
    else for (const question of questions) await ask(question)
  } finally {
    inbox.stop()
  }
}

async function inspect(directory: string, requestId: string | null): Promise<void> {
  console.log(JSON.stringify(await readTrace(directory, requestId), null, 2))
}

// Short enough for a bird to repeat without typos.
function shortId(): string {
  return `q-${crypto.randomUUID().slice(0, 6)}`
}

function usage(): string {
  return [
    "Usage:",
    '  bun run experiment:local-flock run [--async [--concurrent]] <scenario.json> "<question>" ["<next-question>" ...]',
    "  bun run experiment:local-flock inspect <run-directory> [request-id]",
  ].join("\n")
}
