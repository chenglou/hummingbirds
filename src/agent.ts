import { appendFile } from "node:fs/promises"

import {
  headers,
  requireRecord,
  requireString,
  type JsonObject,
  type TraceEvent,
} from "./protocol.ts"

export type AgentRequest = {
  address: string
  callerId: string
  invocationId: string
  nodeId: string
  parentInvocationId: string | null
  path: string[]
  requestId: string
}

type AgentReply = {
  body: string
  status: number
}

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max"

type ApiResponse = {
  output: JsonObject[]
  raw: JsonObject
}

type ApiResult =
  | { ok: true; response: ApiResponse }
  | { error: string; ok: false }

type AgentResult =
  | { answer: string; ok: true }
  | { error: string; ok: false }

type FunctionCall = {
  arguments: string
  callId: string
  name: "ask_node" | "replace_nodes"
}

const apiKey = requireEnvironment("OPENAI_API_KEY")
const apiBaseUrl = Bun.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1"
const model = Bun.env["OPENAI_MODEL"] ?? "gpt-5.6-luna"
const reasoningEffort = parseReasoningEffort(Bun.env["OPENAI_REASONING_EFFORT"])
let sequence = 0

const tools = [
  {
    type: "function",
    name: "ask_node",
    description: "Ask another agent node at a full HTTP address and return its raw reply.",
    parameters: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "The node's full /ask URL, copied from nodes.md or a contributor attribution.",
        },
        question: {
          type: "string",
          description: "The incoming question, unchanged.",
        },
      },
      required: ["address", "question"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "replace_nodes",
    description: "Replace your own nodes.md with routing knowledge you chose to retain.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The complete new contents of nodes.md.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
    strict: true,
  },
  { type: "web_search" },
]

export async function answerQuestion(
  question: string,
  request: AgentRequest,
): Promise<AgentReply> {
  const startedAt = performance.now()
  await record({
    ...eventBase(request),
    callerId: request.callerId,
    kind: "request_received",
    path: request.path,
    question,
  })

  if (request.path.includes(request.nodeId)) {
    await record({
      ...eventBase(request),
      callerId: request.callerId,
      kind: "cycle_rejected",
      path: request.path,
      question,
    })
    return { body: `Cycle rejected at ${request.nodeId}.`, status: 409 }
  }

  const context = { ...request, path: [...request.path, request.nodeId] }
  try {
    const [prompt, knowledge, nodes] = await Promise.all([
      Bun.file("prompt.md").text(),
      Bun.file("knowledge.md").text(),
      Bun.file("nodes.md").text(),
    ])
    const result = await runAgent(
      question,
      renderInstructions(prompt, knowledge, nodes, context),
      context,
    )
    if (!result.ok) {
      await record({
        ...eventBase(context),
        durationMs: performance.now() - startedAt,
        error: result.error,
        kind: "request_failed",
        status: 502,
      })
      return { body: result.error, status: 502 }
    }
    await record({
      ...eventBase(context),
      answer: result.answer,
      durationMs: performance.now() - startedAt,
      kind: "request_completed",
      status: 200,
    })
    return { body: result.answer, status: 200 }
  } catch (error) {
    const message = errorMessage(error)
    await record({
      ...eventBase(context),
      durationMs: performance.now() - startedAt,
      error: message,
      kind: "request_failed",
      status: 500,
    })
    return { body: message, status: 500 }
  }
}

async function runAgent(
  question: string,
  instructions: string,
  context: AgentRequest,
): Promise<AgentResult> {
  const input: JsonObject[] = [{ role: "user", content: question }]

  for (let apiCall = 1; ; apiCall += 1) {
    const result = await callModel(instructions, input, context, apiCall)
    if (!result.ok) return result

    input.push(...result.response.output)
    const calls = parseFunctionCalls(result.response.output)
    if (calls.length === 0) {
      const answer = outputText(result.response.output)
      if (answer.length === 0) return { error: "The model returned no answer.", ok: false }
      return { answer, ok: true }
    }
    input.push(...(await executeFunctions(calls, context)))
  }
}

async function callModel(
  instructions: string,
  input: JsonObject[],
  context: AgentRequest,
  apiCall: number,
): Promise<ApiResult> {
  const startedAt = performance.now()
  const requestBody: JsonObject = {
    include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
    input,
    instructions,
    model,
    parallel_tool_calls: true,
    reasoning: { effort: reasoningEffort },
    store: false,
    tools,
  }
  let responseBody = ""

  try {
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })
    responseBody = await response.text()
    if (!response.ok) {
      const error = `OpenAI HTTP ${response.status}: ${responseBody}`
      await record({
        ...eventBase(context),
        apiCall,
        durationMs: performance.now() - startedAt,
        error,
        kind: "api_failed",
        request: requestBody,
        responseBody,
      })
      return { error, ok: false }
    }

    const parsed = parseApiResponse(parseJson(responseBody))
    await record({
      ...eventBase(context),
      apiCall,
      durationMs: performance.now() - startedAt,
      kind: "api_completed",
      request: requestBody,
      response: parsed.raw,
    })
    return { ok: true, response: parsed }
  } catch (error) {
    const message = `OpenAI request failed: ${errorMessage(error)}`
    await record({
      ...eventBase(context),
      apiCall,
      durationMs: performance.now() - startedAt,
      error: message,
      kind: "api_failed",
      request: requestBody,
      responseBody,
    })
    return { error: message, ok: false }
  }
}

async function executeFunctions(
  calls: FunctionCall[],
  context: AgentRequest,
): Promise<JsonObject[]> {
  const outputs: Array<JsonObject | null> = calls.map(() => null)
  const asks: Array<{ call: FunctionCall; index: number }> = []
  for (const [index, call] of calls.entries()) {
    if (call.name === "ask_node") asks.push({ call, index })
  }

  await Promise.all(
    asks.map(async ({ call, index }) => {
      outputs[index] = await executeFunction(call, context)
    }),
  )

  for (const [index, call] of calls.entries()) {
    if (call.name === "replace_nodes") outputs[index] = await executeFunction(call, context)
  }

  return outputs.map((output) => {
    if (output === null) throw new Error("A function call produced no output")
    return output
  })
}

async function executeFunction(
  call: FunctionCall,
  context: AgentRequest,
): Promise<JsonObject> {
  const argumentsRecord = requireRecord(parseJson(call.arguments), `${call.name} arguments`)
  let output: string
  switch (call.name) {
    case "ask_node":
      output = await askNode(
        call.callId,
        requireString(argumentsRecord, "address"),
        requireString(argumentsRecord, "question"),
        context,
      )
      break
    case "replace_nodes":
      output = await replaceNodes(requireString(argumentsRecord, "content"), context)
      break
  }
  return { type: "function_call_output", call_id: call.callId, output }
}

async function askNode(
  callId: string,
  peerAddress: string,
  question: string,
  context: AgentRequest,
): Promise<string> {
  const startedAt = performance.now()
  await record({
    ...eventBase(context),
    address: peerAddress,
    callId,
    kind: "peer_call_started",
    question,
  })

  try {
    const response = await fetch(peerAddress, {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        [headers.callerId]: context.nodeId,
        [headers.invocationId]: callId,
        [headers.parentInvocationId]: context.invocationId,
        [headers.path]: JSON.stringify(context.path),
        [headers.requestId]: context.requestId,
      },
      body: question,
    })
    const answer = await response.text()
    await record({
      ...eventBase(context),
      address: peerAddress,
      answer,
      callId,
      durationMs: performance.now() - startedAt,
      kind: "peer_call_completed",
      status: response.status,
    })
    return response.ok ? answer : `Peer HTTP ${response.status}: ${answer}`
  } catch (error) {
    const message = errorMessage(error)
    await record({
      ...eventBase(context),
      address: peerAddress,
      callId,
      durationMs: performance.now() - startedAt,
      error: message,
      kind: "peer_call_failed",
    })
    return `Peer request failed: ${message}`
  }
}

async function replaceNodes(content: string, context: AgentRequest): Promise<string> {
  const before = await Bun.file("nodes.md").text()
  await Bun.write("nodes.md", content)
  await record({
    ...eventBase(context),
    after: content,
    before,
    kind: "nodes_replaced",
  })
  return "nodes.md updated."
}

function parseApiResponse(value: unknown): ApiResponse {
  const record = requireRecord(value, "Responses API response")
  const rawOutput = record["output"]
  if (!Array.isArray(rawOutput)) throw new Error("Responses API output must be an array")
  const output = rawOutput.map((item) => requireRecord(item, "Responses API output item"))
  requireString(record, "id")
  return { output, raw: record }
}

function parseFunctionCalls(output: JsonObject[]): FunctionCall[] {
  const calls: FunctionCall[] = []
  for (const item of output) {
    if (item["type"] !== "function_call") continue
    const name = requireString(item, "name")
    switch (name) {
      case "ask_node":
      case "replace_nodes":
        calls.push({
          arguments: requireString(item, "arguments"),
          callId: requireString(item, "call_id"),
          name,
        })
        break
      default:
        throw new Error(`Unknown function call: ${name}`)
    }
  }
  return calls
}

function outputText(output: JsonObject[]): string {
  const chunks: string[] = []
  for (const item of output) {
    if (item["type"] !== "message") continue
    const content = item["content"]
    if (!Array.isArray(content)) throw new Error("Responses API message content must be an array")
    for (const rawBlock of content) {
      const block = requireRecord(rawBlock, "Responses API message content")
      if (block["type"] === "output_text") chunks.push(requireString(block, "text"))
    }
  }
  return chunks.join("\n")
}

function renderInstructions(
  prompt: string,
  knowledge: string,
  nodes: string,
  context: AgentRequest,
): string {
  return `${prompt.replaceAll("[id]", context.nodeId).replaceAll("[address]", context.address)}

Incoming request ID: ${context.requestId}
Immediate caller ID: ${context.callerId}

Current knowledge.md:

${knowledge}

Current nodes.md:

${nodes}`
}

function eventBase(context: AgentRequest): Omit<TraceEvent, "kind"> {
  return {
    at: performance.timeOrigin + performance.now(),
    invocationId: context.invocationId,
    nodeId: context.nodeId,
    parentInvocationId: context.parentInvocationId,
    pid: process.pid,
    requestId: context.requestId,
    seq: (sequence += 1),
  }
}

async function record(event: TraceEvent): Promise<void> {
  await appendFile("events.jsonl", `${JSON.stringify(event)}\n`)
}

function parseJson(value: string): unknown {
  return JSON.parse(value)
}

function requireEnvironment(name: string): string {
  const value = Bun.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort {
  switch (value ?? "low") {
    case "none":
      return "none"
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
      return "high"
    case "xhigh":
      return "xhigh"
    case "max":
      return "max"
    default:
      throw new Error(`Invalid OPENAI_REASONING_EFFORT: ${value}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
