export const headers = {
  callerId: "x-hummingbirds-caller-id",
  invocationId: "x-hummingbirds-invocation-id",
  parentInvocationId: "x-hummingbirds-parent-invocation-id",
  path: "x-hummingbirds-path",
  requestId: "x-hummingbirds-request-id",
} as const

export type JsonObject = Record<string, unknown>

type EventBase = {
  at: number
  invocationId: string
  nodeId: string
  parentInvocationId: string | null
  pid: number
  requestId: string
  seq: number
}

export type TraceEvent =
  | (EventBase & {
      callerId: string
      kind: "request_received"
      path: string[]
      question: string
    })
  | (EventBase & {
      callerId: string
      kind: "cycle_rejected"
      path: string[]
      question: string
    })
  | (EventBase & {
      agentPid: number
      codexEvents: string | null
      kind: "codex_process_started"
      threadId: string | null
    })
  | (EventBase & {
      agentPid: number
      durationMs: number
      kind: "codex_process_completed"
      threadId: string
    })
  | (EventBase & {
      agentPid: number
      durationMs: number
      error: string
      exitCode: number
      kind: "codex_process_failed"
      threadId: string | null
    })
  | (EventBase & {
      apiCall: number
      durationMs: number
      kind: "api_completed"
      request: JsonObject
      response: JsonObject
    })
  | (EventBase & {
      apiCall: number
      durationMs: number
      error: string
      kind: "api_failed"
      request: JsonObject
      responseBody: string
    })
  | (EventBase & {
      address: string
      callId: string
      kind: "peer_call_started"
      question: string
    })
  | (EventBase & {
      address: string
      answer: string
      callId: string
      durationMs: number
      kind: "peer_call_completed"
      status: number
    })
  | (EventBase & {
      address: string
      callId: string
      durationMs: number
      error: string
      kind: "peer_call_failed"
    })
  | (EventBase & {
      after: string
      before: string
      kind: "nodes_replaced"
    })
  | (EventBase & {
      answer: string
      durationMs: number
      kind: "request_completed"
      status: number
    })
  | (EventBase & {
      durationMs: number
      error: string
      kind: "request_failed"
      status: number
    })

export function parsePath(value: string | null): string[] {
  if (value === null) return []

  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${headers.path} must be a JSON array of node IDs`)
  }
  return parsed
}

export function requireRecord(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonObject
}

export function requireString(record: JsonObject, key: string): string {
  const value = record[key]
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

export function requireNumber(record: JsonObject, key: string): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`)
  }
  return value
}
