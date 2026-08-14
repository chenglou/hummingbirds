import { answerQuestion } from "./agent.ts"
import { headers, parsePath } from "./protocol.ts"

const nodeId = requireEnvironment("NET_NODE_ID")
const port = parsePort(Bun.env["NET_PORT"] ?? "0")
let address = ""

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: handleRequest,
})

address = `http://127.0.0.1:${server.port}/ask`
console.log(JSON.stringify({ id: nodeId, pid: process.pid, url: address }))

async function handleRequest(request: Request): Promise<Response> {
  if (new URL(request.url).pathname !== "/ask") {
    return new Response("Not found", { status: 404 })
  }
  if (request.method !== "POST") {
    return new Response("POST a plain-text question", { status: 405 })
  }

  const requestId = request.headers.get(headers.requestId) ?? crypto.randomUUID()
  const invocationId = request.headers.get(headers.invocationId) ?? crypto.randomUUID()
  let path: string[]
  try {
    path = parsePath(request.headers.get(headers.path))
  } catch (error) {
    return textResponse(errorMessage(error), 400, requestId, invocationId)
  }

  const reply = await answerQuestion(await request.text(), {
    address,
    callerId: request.headers.get(headers.callerId) ?? "human",
    invocationId,
    nodeId,
    parentInvocationId: request.headers.get(headers.parentInvocationId),
    path,
    requestId,
  })
  return textResponse(reply.body, reply.status, requestId, invocationId)
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
