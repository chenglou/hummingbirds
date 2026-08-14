import { appendFile } from "node:fs/promises"

import {
  headers,
  parsePath,
  requireRecord,
  requireString,
  type JsonObject,
  type TraceEvent,
} from "./protocol.ts"

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

type TraceContext = {
  invocationId: string
  parentInvocationId: string | null
  requestId: string
}

type RequestContext = TraceContext & {
  callerId: string
  path: string[]
}

const nodeId = requireEnvironment("NET_NODE_ID")
const apiKey = requireEnvironment("OPENAI_API_KEY")
const apiBaseUrl = Bun.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1"
const model = Bun.env["OPENAI_MODEL"] ?? "gpt-5.6-luna"
const reasoningEffort = parseReasoningEffort(Bun.env["OPENAI_REASONING_EFFORT"])
const port = parsePort(Bun.env["NET_PORT"] ?? "0")
let sequence = 0
let address = ""

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

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: handleHttpRequest,
})

address = `http://127.0.0.1:${server.port}/ask`
console.log(JSON.stringify({ id: nodeId, pid: process.pid, url: address }))

async function handleHttpRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== "/ask") return new Response("Not found", { status: 404 })
  if (request.method !== "POST") return new Response("POST a plain-text question", { status: 405 })

  const requestId = request.headers.get(headers.requestId) ?? crypto.randomUUID()
  const invocationId = request.headers.get(headers.invocationId) ?? crypto.randomUUID()
  const parentInvocationId = request.headers.get(headers.parentInvocationId)
  const callerId = request.headers.get(headers.callerId) ?? "human"
  const question = await request.text()
  const startedAt = performance.now()

  let path: string[]
  try {
    path = parsePath(request.headers.get(headers.path))
  } catch (error) {
    return textResponse(errorMessage(error), 400, requestId, invocationId)
  }

  const context: RequestContext = {
    callerId,
    invocationId,
    parentInvocationId,
    path: [...path, nodeId],
    requestId,
  }

  await record({
    ...eventBase(context),
    callerId,
    kind: "request_received",
    path,
    question,
  })

  if (path.includes(nodeId)) {
    await record({
      ...eventBase(context),
      callerId,
      kind: "cycle_rejected",
      path,
      question,
    })
    return textResponse(`Cycle rejected at ${nodeId}.`, 409, requestId, invocationId)
  }

  try {
    const [prompt, knowledge, nodes] = await Promise.all([
      Bun.file("prompt.md").text(),
      Bun.file("knowledge.md").text(),
      Bun.file("nodes.md").text(),
    ])
    const instructions = renderInstructions(prompt, knowledge, nodes, context)
    const result = await runAgent(question, instructions, context)

    if (!result.ok) {
      const status = 502
      await record({
        ...eventBase(context),
        durationMs: performance.now() - startedAt,
        error: result.error,
        kind: "request_failed",
        status,
      })
      return textResponse(result.error, status, requestId, invocationId)
    }

    const status = 200
    await record({
      ...eventBase(context),
      answer: result.answer,
      durationMs: performance.now() - startedAt,
      kind: "request_completed",
      status,
    })
    return textResponse(result.answer, status, requestId, invocationId)
  } catch (error) {
    const message = errorMessage(error)
    const status = 500
    await record({
      ...eventBase(context),
      durationMs: performance.now() - startedAt,
      error: message,
      kind: "request_failed",
      status,
    })
    return textResponse(message, status, requestId, invocationId)
  }
}

async function runAgent(
  question: string,
  instructions: string,
  context: RequestContext,
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

    const outputs = await executeFunctions(calls, context)
    input.push(...outputs)
  }
}

async function callModel(
  instructions: string,
  input: JsonObject[],
  context: TraceContext,
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
  context: RequestContext,
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
  context: RequestContext,
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

  return {
    type: "function_call_output",
    call_id: call.callId,
    output,
  }
}

async function askNode(
  callId: string,
  peerAddress: string,
  question: string,
  context: RequestContext,
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
        [headers.callerId]: nodeId,
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

async function replaceNodes(content: string, context: TraceContext): Promise<string> {
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
  context: RequestContext,
): string {
  return `${prompt.replaceAll("[id]", nodeId).replaceAll("[address]", address)}

Incoming request ID: ${context.requestId}
Immediate caller ID: ${context.callerId}

Current knowledge.md:

${knowledge}

Current nodes.md:

${nodes}`
}

function eventBase(context: TraceContext): Omit<TraceEvent, "kind"> {
  return {
    at: performance.timeOrigin + performance.now(),
    invocationId: context.invocationId,
    nodeId,
    parentInvocationId: context.parentInvocationId,
    pid: process.pid,
    requestId: context.requestId,
    seq: (sequence += 1),
  }
}

async function record(event: TraceEvent): Promise<void> {
  await appendFile("events.jsonl", `${JSON.stringify(event)}\n`)
}

function textResponse(
  body: string,
  status: number,
  requestId: string,
  invocationId: string,
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      [headers.invocationId]: invocationId,
      [headers.requestId]: requestId,
    },
  })
}

function parseJson(value: string): unknown {
  return JSON.parse(value)
}

function requireEnvironment(name: string): string {
  const value = Bun.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function parsePort(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid NET_PORT: ${value}`)
  }
  return parsed
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
