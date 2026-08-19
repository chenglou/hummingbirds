import {
  requireNumber,
  requireRecord,
  requireString,
  type JsonObject,
  type TraceEvent,
} from "./protocol.ts"

export type ReadyMessage = {
  id: string
  pid: number
  url: string
}

export function parseReadyMessage(value: unknown): ReadyMessage {
  const record = requireRecord(value, "ready message")
  return {
    id: requireString(record, "id"),
    pid: requireNumber(record, "pid"),
    url: requireString(record, "url"),
  }
}

export function parseTraceEvent(value: unknown): TraceEvent {
  const record = requireRecord(value, "trace event")
  const base = {
    at: requireNumber(record, "at"),
    invocationId: requireString(record, "invocationId"),
    nodeId: requireString(record, "nodeId"),
    parentInvocationId: requireNullableString(record, "parentInvocationId"),
    pid: requireNumber(record, "pid"),
    requestId: requireString(record, "requestId"),
    seq: requireNumber(record, "seq"),
  }
  const kind = requireString(record, "kind")

  switch (kind) {
    case "request_received":
      return {
        ...base,
        callerId: requireString(record, "callerId"),
        kind,
        path: requireStringArray(record, "path"),
        question: requireString(record, "question"),
      }
    case "cycle_rejected":
      return {
        ...base,
        callerId: requireString(record, "callerId"),
        kind,
        path: requireStringArray(record, "path"),
        question: requireString(record, "question"),
      }
    case "codex_process_started":
      return {
        ...base,
        agentPid: requireNumber(record, "agentPid"),
        codexEvents: optionalString(record, "codexEvents"),
        kind,
        threadId: requireNullableString(record, "threadId"),
      }
    case "codex_process_completed":
      return {
        ...base,
        agentPid: requireNumber(record, "agentPid"),
        durationMs: requireNumber(record, "durationMs"),
        kind,
        threadId: requireString(record, "threadId"),
      }
    case "codex_process_failed":
      return {
        ...base,
        agentPid: requireNumber(record, "agentPid"),
        durationMs: requireNumber(record, "durationMs"),
        error: requireString(record, "error"),
        exitCode: requireNumber(record, "exitCode"),
        kind,
        threadId: requireNullableString(record, "threadId"),
      }
    case "api_completed":
      return {
        ...base,
        apiCall: requireNumber(record, "apiCall"),
        durationMs: requireNumber(record, "durationMs"),
        kind,
        request: requireRecord(record["request"], "API request"),
        response: requireRecord(record["response"], "API response"),
      }
    case "api_failed":
      return {
        ...base,
        apiCall: requireNumber(record, "apiCall"),
        durationMs: requireNumber(record, "durationMs"),
        error: requireString(record, "error"),
        kind,
        request: requireRecord(record["request"], "API request"),
        responseBody: requireString(record, "responseBody"),
      }
    case "peer_call_started":
      return {
        ...base,
        address: requireString(record, "address"),
        callId: requireString(record, "callId"),
        kind,
        question: requireString(record, "question"),
      }
    case "peer_call_completed":
      return {
        ...base,
        address: requireString(record, "address"),
        answer: requireString(record, "answer"),
        callId: requireString(record, "callId"),
        durationMs: requireNumber(record, "durationMs"),
        kind,
        status: requireNumber(record, "status"),
      }
    case "peer_call_failed":
      return {
        ...base,
        address: requireString(record, "address"),
        callId: requireString(record, "callId"),
        durationMs: requireNumber(record, "durationMs"),
        error: requireString(record, "error"),
        kind,
      }
    case "nodes_replaced":
      return {
        ...base,
        after: requireString(record, "after"),
        before: requireString(record, "before"),
        kind,
      }
    case "request_completed":
      return {
        ...base,
        answer: requireString(record, "answer"),
        durationMs: requireNumber(record, "durationMs"),
        kind,
        status: requireNumber(record, "status"),
      }
    case "request_failed":
      return {
        ...base,
        durationMs: requireNumber(record, "durationMs"),
        error: requireString(record, "error"),
        kind,
        status: requireNumber(record, "status"),
      }
    default:
      throw new Error(`Unknown trace event kind: ${kind}`)
  }
}

function requireStringArray(record: JsonObject, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be an array of strings`)
  }
  return value
}

function requireNullableString(record: JsonObject, key: string): string | null {
  const value = record[key]
  if (value !== null && typeof value !== "string") {
    throw new Error(`${key} must be a string or null`)
  }
  return value
}

function optionalString(record: JsonObject, key: string): string | null {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new Error(`${key} must be a string or null`)
  return value
}
