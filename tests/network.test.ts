import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  askNetwork,
  readTrace,
  startNetwork,
  stopNetwork,
  type RunningNetwork,
} from "../src/harness.ts"
import { headers, requireRecord, requireString } from "../src/protocol.ts"

type ModelObservation = {
  callerId: string
  functionNames: string[]
  nodeId: string
  question: string
  requestId: string
  toolOutputs: number
}

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("Hummingbirds", () => {
  test("learns and uses a transitive route across independent processes", async () => {
    const trainingQuestion =
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for tideglass trial Nacre-A?"
    const probeQuestion =
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for saltclock trial Nacre-B?"
    const trainingRequestId = "request-training"
    const probeRequestId = "request-probe"
    const fake = startFakeResponsesApi()
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "hummingbirds-"))
    temporaryDirectories.push(temporaryDirectory)
    const runDirectory = join(temporaryDirectory, "run")
    let network: RunningNetwork | null = null

    try {
      network = await startNetwork(resolve("example/scenario.json"), runDirectory, {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: `${fake.url}/v1`,
        OPENAI_MODEL: "fixture-model",
      })

      const a = findNode(network, "a")
      const b = findNode(network, "b")
      const c = findNode(network, "c")
      expect(new Set(network.nodes.map((node) => node.pid)).size).toBe(3)
      expect(new Set(network.nodes.map((node) => node.url)).size).toBe(3)
      expect(await readFile(join(a.directory, "server.ts"), "utf8")).toBe(
        await readFile(resolve("src/server.ts"), "utf8"),
      )
      expect(await readFile(join(a.directory, "prompt.md"), "utf8")).toBe(
        await readFile(resolve("src/prompt.md"), "utf8"),
      )

      const initialA = await readFile(join(a.directory, "nodes.md"), "utf8")
      expect(initialA).toBe(`# Known nodes\n\n- b at ${b.url} — known, but no experience yet.\n`)
      expect(initialA).not.toContain("c at")

      const trainingResult = await askNetwork(network, trainingQuestion, trainingRequestId)
      const trainingAnswer = `Amber Tern-417.\n\nContributors: c at ${c.url}`
      expect(trainingResult.answer).toBe(trainingAnswer)
      expect(trainingResult.requestId).toBe(trainingRequestId)
      expect(trainingResult.invocationId.length).toBeGreaterThan(0)
      expect(trainingResult.status).toBe(200)

      const trainedA = `# Known nodes\n\n- b at ${b.url} — successfully relayed pelagic-lichen ledger questions.\n- c at ${c.url} — answered pelagic-lichen ledger questions, learned via b.\n`
      const trainedB = `# Known nodes\n\n- c at ${c.url} — answered pelagic-lichen ledger questions.\n`
      expect(await readFile(join(a.directory, "nodes.md"), "utf8")).toBe(trainedA)
      expect(await readFile(join(b.directory, "nodes.md"), "utf8")).toBe(trainedB)
      expect(await readFile(join(c.directory, "nodes.md"), "utf8")).toBe("# Known nodes\n")
      expect(trainedA).not.toContain("Amber Tern-417")

      const firstCalls = fake.observations.filter(
        (observation) =>
          observation.requestId === trainingRequestId && observation.toolOutputs === 0,
      )
      expect(firstCalls.map((observation) => observation.nodeId).sort()).toEqual(["a", "b", "c"])
      expect(firstCalls.every((observation) => observation.question === trainingQuestion)).toBe(true)
      expect(firstCalls.map((observation) => observation.callerId).sort()).toEqual(["b", "human", "a"].sort())
      expect(
        fake.observations.every(
          (observation) =>
            observation.functionNames.includes("ask_node") &&
            observation.functionNames.includes("replace_nodes"),
        ),
      ).toBe(true)

      const trace = await readTrace(runDirectory, trainingRequestId)
      expect(trace.length).toBeGreaterThan(0)
      expect(trace.every((event) => event.requestId === trainingRequestId)).toBe(true)
      expect(new Set(trace.map((event) => event.pid))).toEqual(new Set([a.pid, b.pid, c.pid]))

      const receipts = trace.filter((event) => event.kind === "request_received")
      expect(receipts.map((event) => [event.nodeId, event.callerId])).toEqual([
        ["a", "human"],
        ["b", "a"],
        ["c", "b"],
      ])
      const peerCalls = trace.filter((event) => event.kind === "peer_call_started")
      expect(peerCalls.map((event) => [event.nodeId, event.address, event.question])).toEqual([
        ["a", b.url, trainingQuestion],
        ["b", c.url, trainingQuestion],
      ])
      expect(trace.filter((event) => event.kind === "nodes_replaced").map((event) => event.nodeId)).toEqual([
        "b",
        "a",
      ])
      const apiEvents = trace.filter((event) => event.kind === "api_completed")
      expect(apiEvents.some((event) => JSON.stringify(event.response).includes("ask_node"))).toBe(true)

      const rootReceipt = requireEvent(receipts, "a")
      const relayReceipt = requireEvent(receipts, "b")
      const answererReceipt = requireEvent(receipts, "c")
      const aCall = requireEvent(peerCalls, "a")
      const bCall = requireEvent(peerCalls, "b")
      expect(rootReceipt.parentInvocationId).toBeNull()
      expect(relayReceipt.parentInvocationId).toBe(rootReceipt.invocationId)
      expect(relayReceipt.invocationId).toBe(aCall.callId)
      expect(answererReceipt.parentInvocationId).toBe(relayReceipt.invocationId)
      expect(answererReceipt.invocationId).toBe(bCall.callId)

      const probeResult = await askNetwork(network, probeQuestion, probeRequestId)
      expect(probeResult.answer).toBe(`Violet Shoal-862.\n\nContributors: c at ${c.url}`)
      expect(probeResult.requestId).toBe(probeRequestId)
      expect(probeResult.status).toBe(200)
      const probeTrace = await readTrace(runDirectory, probeRequestId)
      expect(
        probeTrace
          .filter((event) => event.kind === "peer_call_started")
          .map((event) => [event.nodeId, event.address, event.question]),
      ).toEqual([["a", c.url, probeQuestion]])
      expect(probeTrace.filter((event) => event.kind === "request_received").map((event) => event.nodeId)).toEqual([
        "a",
        "c",
      ])
      expect(await readFile(join(b.directory, "nodes.md"), "utf8")).toBe(trainedB)
      expect(await readFile(join(a.directory, "nodes.md"), "utf8")).toBe(
        `# Known nodes\n\n- b at ${b.url} — successfully relayed pelagic-lichen ledger questions.\n- c at ${c.url} — directly answered pelagic-lichen ledger questions after a referral via b.\n`,
      )

      const callsBeforeCycle = fake.observations.length
      const cycleResponse = await fetch(a.url, {
        method: "POST",
        headers: {
          [headers.callerId]: "test",
          [headers.path]: JSON.stringify(["a"]),
          [headers.requestId]: "request-cycle",
        },
        body: trainingQuestion,
      })
      expect(cycleResponse.status).toBe(409)
      expect(fake.observations.length).toBe(callsBeforeCycle)
    } finally {
      if (network !== null) await stopNetwork(network)
      await fake.server.stop(true)
    }
  }, 20_000)
})

function startFakeResponsesApi(): {
  observations: ModelObservation[]
  server: ReturnType<typeof Bun.serve>
  url: string
} {
  const observations: ModelObservation[] = []
  let responseNumber = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/v1/responses") return new Response("Not found", { status: 404 })
      const body = requireRecord(parseJson(await request.text()), "fixture request")
      const instructions = requireString(body, "instructions")
      const input = body["input"]
      if (!Array.isArray(input)) throw new Error("fixture input must be an array")
      const nodeId = extract(instructions, /Your ID is ([^,]+),/, "node ID")
      const nodeAddress = extract(
        instructions,
        /your address is (http:\/\/\S+\/ask)\./,
        "node address",
      )
      const requestId = extract(instructions, /Incoming request ID: (\S+)/, "request ID")
      const callerId = extract(instructions, /Immediate caller ID: (\S+)/, "caller ID")
      const question = findQuestion(input)
      const functionNames = findFunctionNames(body)
      const toolOutputs = input.filter(
        (item) => requireRecord(item, "fixture input item")["type"] === "function_call_output",
      )
      observations.push({
        callerId,
        functionNames,
        nodeId,
        question,
        requestId,
        toolOutputs: toolOutputs.length,
      })

      let output: Record<string, unknown>[]
      if (nodeId === "c") {
        const trial = extract(question, /(Nacre-[A-Z])/, "trial")
        const phrase = extract(
          instructions,
          new RegExp(`${trial} records the exact harbor phrase “([^”]+)”`),
          "private answer",
        )
        output = [message(`${phrase}\n\nContributors: c at ${nodeAddress}`)]
      } else if (toolOutputs.length === 0) {
        const peerAddress =
          nodeId === "a" && question.includes("Nacre-B")
            ? addressOf(instructions, "c")
            : extract(
                instructions,
                /- [A-Za-z0-9_-]+ at (http:\/\/\S+\/ask) —/,
                "known node address",
              )
        output = [functionCall("ask_node", { address: peerAddress, question })]
      } else if (toolOutputs.length === 1) {
        const peerAnswer = requireString(requireRecord(toolOutputs[0], "tool output"), "output")
        const contributorAddress = extract(
          peerAnswer,
          /c at (http:\/\/\S+\/ask)/,
          "contributor address",
        )
        const content =
          nodeId === "a"
            ? question.includes("Nacre-B")
              ? `# Known nodes\n\n- b at ${addressOf(instructions, "b")} — successfully relayed pelagic-lichen ledger questions.\n- c at ${contributorAddress} — directly answered pelagic-lichen ledger questions after a referral via b.\n`
              : `# Known nodes\n\n- b at ${addressOf(instructions, "b")} — successfully relayed pelagic-lichen ledger questions.\n- c at ${contributorAddress} — answered pelagic-lichen ledger questions, learned via b.\n`
            : `# Known nodes\n\n- c at ${addressOf(instructions, "c")} — answered pelagic-lichen ledger questions.\n`
        output = [functionCall("replace_nodes", { content })]
      } else {
        output = [message(requireString(requireRecord(toolOutputs[0], "tool output"), "output"))]
      }

      responseNumber += 1
      return Response.json({
        id: `fixture-response-${responseNumber}`,
        output,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      })
    },
  })
  return { observations, server, url: `http://127.0.0.1:${server.port}` }
}

function functionCall(name: string, arguments_: Record<string, string>): Record<string, unknown> {
  return {
    arguments: JSON.stringify(arguments_),
    call_id: crypto.randomUUID(),
    name,
    type: "function_call",
  }
}

function message(text: string): Record<string, unknown> {
  return {
    content: [{ annotations: [], text, type: "output_text" }],
    role: "assistant",
    status: "completed",
    type: "message",
  }
}

function findQuestion(input: unknown[]): string {
  for (const item of input) {
    const record = requireRecord(item, "fixture input item")
    if (record["role"] === "user") return requireString(record, "content")
  }
  throw new Error("fixture request has no user question")
}

function findFunctionNames(body: Record<string, unknown>): string[] {
  const tools = body["tools"]
  if (!Array.isArray(tools)) throw new Error("fixture tools must be an array")
  const names: string[] = []
  for (const rawTool of tools) {
    const tool = requireRecord(rawTool, "fixture tool")
    if (tool["type"] === "function") names.push(requireString(tool, "name"))
  }
  return names
}

function addressOf(instructions: string, id: string): string {
  return extract(
    instructions,
    new RegExp(`- ${id} at (http:\\/\\/\\S+\\/ask) —`),
    `${id} address`,
  )
}

function extract(text: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(text)
  const value = match?.[1]
  if (value === undefined) throw new Error(`Could not extract ${label}`)
  return value
}

function findNode(network: RunningNetwork, id: string): RunningNetwork["nodes"][number] {
  const node = network.nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`Missing test node ${id}`)
  return node
}

function requireEvent<T extends { nodeId: string }>(events: T[], nodeId: string): T {
  const event = events.find((candidate) => candidate.nodeId === nodeId)
  if (event === undefined) throw new Error(`Missing ${nodeId} event`)
  return event
}

function parseJson(value: string): unknown {
  return JSON.parse(value)
}
