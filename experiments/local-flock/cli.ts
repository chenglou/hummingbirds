import { resolve } from "path"

import { askNetwork, readTrace, startNetwork, stopNetwork } from "./harness.ts"

// The one flag comes right after the command; everything after it is positional, so
// a question may start with "--".
const [command, ...rest] = process.argv.slice(2)
const concurrent = rest[0] === "--concurrent"
const args = concurrent ? rest.slice(1) : rest
try {
  if (command === "run" && args.length >= 2) await run(args[0] ?? "", args.slice(1))
  else if (command === "inspect" && args.length >= 1) await inspect(args[0] ?? "", args[1] ?? null)
  else throw new Error(usage())
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

// Ask one question after another, or with --concurrent fire them all at once and let
// the flock sort it out. Replies print once the flock goes quiet.
async function run(scenarioPath: string, questions: string[]): Promise<void> {
  const directory = resolve("logs", new Date().toISOString().replaceAll(":", "-"))
  const network = await startNetwork(scenarioPath, directory)
  try {
    const requestIds = new Set<string>()
    const ask = async (question: string): Promise<void> => {
      const requestId = shortId()
      requestIds.add(requestId)
      console.error(`request: ${requestId}`)
      const result = await askNetwork(network, question, requestId)
      if (result.status !== 202 || result.replies.length === 0) process.exitCode = 1
      if (!result.settled) console.error(`flock still busy, gave up waiting on ${requestId}`)
      if (result.replies.length === 0) console.error(`no reply for ${requestId}`)
      for (const message of result.replies) {
        process.stdout.write(`[${requestId}] from ${message.from}:\n${message.body}\n\n`)
      }
    }
    if (concurrent) await Promise.all(questions.map(ask))
    else for (const question of questions) await ask(question)
    // A bird that slipped on the in-reply-to header still deserves to be heard.
    for (const message of network.inbox.messages) {
      if (message.inReplyTo !== null && requestIds.has(message.inReplyTo)) continue
      process.stdout.write(
        `[in reply to ${message.inReplyTo ?? "nothing"}] from ${message.from}:\n${message.body}\n\n`,
      )
    }
    console.error(`run: ${directory}`)
  } finally {
    await stopNetwork(network)
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
    '  bun run experiment:local-flock run [--concurrent] <scenario.json> "<question>" ["<next-question>" ...]',
    "  bun run experiment:local-flock inspect <run-directory> [request-id]",
  ].join("\n")
}
