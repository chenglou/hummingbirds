import {
  expectArray,
  expectBoolean,
  expectInteger,
  expectObject,
  expectString,
  type JsonObject,
  type JsonValue,
} from "./json.ts";

export const PROTOCOL_VERSION = 3;

export interface WorkerManifest {
  instructions: string;
  execution: JsonValue;
}

export interface RunDefinition {
  id: string;
  protocolVersion: number;
  createdAt: string;
  worker: WorkerManifest | null;
}

export interface RunCompletion {
  status: "completed" | "stopped";
  summary: JsonValue;
}

export interface NodeDefinition {
  id: string;
  systemPrompt: string;
  corpus: JsonValue;
  initialState: JsonValue;
}

export interface NodeRuntime {
  definition: NodeDefinition;
  generation: number;
  state: JsonValue;
}

export interface Message {
  id: string;
  requestId: string;
  callerId: string | null;
  to: string;
  body: JsonValue;
  causationId: string | null;
}

export interface Lease {
  id: string;
  workerId: string;
  messageId: string;
  nodeId: string;
  expectedGeneration: number;
  createdAt: string;
}

export interface ProposedMessage {
  to: string;
  body: JsonValue;
}

export interface ProposedTransition {
  nextState: JsonValue;
  outgoing: ProposedMessage[];
  result: JsonValue;
}

export interface WorkerEnvelope {
  protocolVersion: number;
  runId: string;
  leaseId: string;
  worker: WorkerManifest | null;
  node: {
    id: string;
    generation: number;
    systemPrompt: string;
    corpus: JsonValue;
    state: JsonValue;
  };
  incoming: Message;
  outputContract: {
    nextState: "json";
    outgoing: "array<{to:string,body:json}>";
    result: "json";
  };
}

export type Event =
  | {
      seq: number;
      at: string;
      kind: "run_created";
      run: RunDefinition;
    }
  | {
      seq: number;
      at: string;
      kind: "node_added";
      node: NodeDefinition;
    }
  | {
      seq: number;
      at: string;
      kind: "message_queued";
      message: Message;
    }
  | {
      seq: number;
      at: string;
      kind: "turn_leased";
      lease: Lease;
      inputHash: string;
    }
  | {
      seq: number;
      at: string;
      kind: "turn_attempted";
      attemptId: string;
      leaseId: string;
      responseHash: string;
      accepted: boolean;
      error: string | null;
    }
  | {
      seq: number;
      at: string;
      kind: "turn_committed";
      leaseId: string;
      messageId: string;
      nodeId: string;
      previousGeneration: number;
      nextState: JsonValue;
      outgoing: Message[];
      result: JsonValue;
      inputHash: string;
      outputHash: string;
    }
  | {
      seq: number;
      at: string;
      kind: "turn_failed";
      leaseId: string;
      messageId: string;
      nodeId: string;
      reason: string;
    }
  | {
      seq: number;
      at: string;
      kind: "run_completed";
      completion: RunCompletion;
    };

export type MessageStatus = "queued" | "leased" | "done" | "failed";

export interface MessageRuntime {
  message: Message;
  status: MessageStatus;
}

export interface LeaseRuntime {
  lease: Lease;
  status: "active" | "committed" | "failed";
  inputHash: string;
}

export interface AttemptRuntime {
  id: string;
  leaseId: string;
  responseHash: string;
  accepted: boolean;
  error: string | null;
}

export interface RunView {
  run: RunDefinition | null;
  nodes: Map<string, NodeRuntime>;
  messages: Map<string, MessageRuntime>;
  leases: Map<string, LeaseRuntime>;
  attempts: Map<string, AttemptRuntime>;
  completion: RunCompletion | null;
}

export function parseNodeDefinition(value: JsonValue): NodeDefinition {
  const object = expectObject(value, "node definition");
  return {
    id: expectString(object["id"], "node definition.id"),
    systemPrompt: expectString(
      object["systemPrompt"],
      "node definition.systemPrompt",
    ),
    corpus: requiredJson(object, "corpus", "node definition"),
    initialState: requiredJson(object, "initialState", "node definition"),
  };
}

export function parseProposedTransition(value: JsonValue): ProposedTransition {
  const object = expectObject(value, "worker proposal");
  const outgoing = expectArray(object["outgoing"], "worker proposal.outgoing").map(
    (item, index): ProposedMessage => {
      const message = expectObject(item, `worker proposal.outgoing[${index}]`);
      return {
        to: expectString(
          message["to"],
          `worker proposal.outgoing[${index}].to`,
        ),
        body: requiredJson(
          message,
          "body",
          `worker proposal.outgoing[${index}]`,
        ),
      };
    },
  );
  return {
    nextState: requiredJson(object, "nextState", "worker proposal"),
    outgoing,
    result: requiredJson(object, "result", "worker proposal"),
  };
}

export function parseEvent(value: JsonValue): Event {
  const object = expectObject(value, "event");
  const seq = expectInteger(object["seq"], "event.seq");
  const at = expectString(object["at"], "event.at");
  const kind = expectString(object["kind"], "event.kind");

  switch (kind) {
    case "run_created":
      return { seq, at, kind, run: parseRunDefinition(object["run"]) };
    case "node_added":
      return {
        seq,
        at,
        kind,
        node: parseNodeDefinition(requiredJson(object, "node", "event")),
      };
    case "message_queued":
      return {
        seq,
        at,
        kind,
        message: parseMessage(object["message"], "event.message"),
      };
    case "turn_leased":
      return {
        seq,
        at,
        kind,
        lease: parseLease(object["lease"]),
        inputHash: expectString(object["inputHash"], "event.inputHash"),
      };
    case "turn_attempted": {
      const errorValue = object["error"];
      return {
        seq,
        at,
        kind,
        attemptId: expectString(object["attemptId"], "event.attemptId"),
        leaseId: expectString(object["leaseId"], "event.leaseId"),
        responseHash: expectString(object["responseHash"], "event.responseHash"),
        accepted: expectBoolean(object["accepted"], "event.accepted"),
        error:
          errorValue === null
            ? null
            : expectString(errorValue, "event.error"),
      };
    }
    case "turn_committed":
      return {
        seq,
        at,
        kind,
        leaseId: expectString(object["leaseId"], "event.leaseId"),
        messageId: expectString(object["messageId"], "event.messageId"),
        nodeId: expectString(object["nodeId"], "event.nodeId"),
        previousGeneration: expectInteger(
          object["previousGeneration"],
          "event.previousGeneration",
        ),
        nextState: requiredJson(object, "nextState", "event"),
        outgoing: expectArray(object["outgoing"], "event.outgoing").map(
          (item, index) => parseMessage(item, `event.outgoing[${index}]`),
        ),
        result: requiredJson(object, "result", "event"),
        inputHash: expectString(object["inputHash"], "event.inputHash"),
        outputHash: expectString(object["outputHash"], "event.outputHash"),
      };
    case "turn_failed":
      return {
        seq,
        at,
        kind,
        leaseId: expectString(object["leaseId"], "event.leaseId"),
        messageId: expectString(object["messageId"], "event.messageId"),
        nodeId: expectString(object["nodeId"], "event.nodeId"),
        reason: expectString(object["reason"], "event.reason"),
      };
    case "run_completed":
      return {
        seq,
        at,
        kind,
        completion: parseRunCompletion(object["completion"]),
      };
    default:
      throw new Error(`Unknown event kind: ${kind}`);
  }
}

function parseRunDefinition(value: JsonValue | undefined): RunDefinition {
  if (value === undefined) {
    throw new Error("event.run is required");
  }
  const object = expectObject(value, "run definition");
  const workerValue = object["worker"];
  return {
    id: expectString(object["id"], "run definition.id"),
    protocolVersion: expectInteger(
      object["protocolVersion"],
      "run definition.protocolVersion",
    ),
    createdAt: expectString(object["createdAt"], "run definition.createdAt"),
    worker:
      workerValue === undefined || workerValue === null
        ? null
        : parseWorkerManifest(workerValue),
  };
}

export function parseWorkerManifest(value: JsonValue): WorkerManifest {
  const object = expectObject(value, "worker manifest");
  return {
    instructions: expectString(
      object["instructions"],
      "worker manifest.instructions",
    ),
    execution: requiredJson(object, "execution", "worker manifest"),
  };
}

function parseRunCompletion(value: JsonValue | undefined): RunCompletion {
  if (value === undefined) {
    throw new Error("event.completion is required");
  }
  const object = expectObject(value, "run completion");
  const status = expectString(object["status"], "run completion.status");
  if (status !== "completed" && status !== "stopped") {
    throw new Error("run completion.status must be completed or stopped");
  }
  return {
    status,
    summary: requiredJson(object, "summary", "run completion"),
  };
}

function parseMessage(value: JsonValue | undefined, label: string): Message {
  if (value === undefined) {
    throw new Error(`${label} is required`);
  }
  const object = expectObject(value, label);
  const id = expectString(object["id"], `${label}.id`);
  const body = requiredJson(object, "body", label);
  const requestIdValue = object["requestId"];
  const callerIdValue =
    object["callerId"] === undefined ? object["from"] : object["callerId"];
  const causationValue = object["causationId"];
  return {
    id,
    requestId:
      requestIdValue === undefined
        ? legacyRequestId(body, id)
        : expectString(requestIdValue, `${label}.requestId`),
    callerId:
      callerIdValue === undefined || callerIdValue === null
        ? null
        : expectString(callerIdValue, `${label}.callerId`),
    to: expectString(object["to"], `${label}.to`),
    body,
    causationId:
      causationValue === null
        ? null
        : expectString(causationValue, `${label}.causationId`),
  };
}

function legacyRequestId(body: JsonValue, fallback: string): string {
  if (body !== null && !Array.isArray(body) && typeof body === "object") {
    const threadId = body["threadId"];
    if (typeof threadId === "string" && threadId.length > 0) {
      return threadId;
    }
  }
  return fallback;
}

function parseLease(value: JsonValue | undefined): Lease {
  if (value === undefined) {
    throw new Error("event.lease is required");
  }
  const object = expectObject(value, "lease");
  return {
    id: expectString(object["id"], "lease.id"),
    workerId: expectString(object["workerId"], "lease.workerId"),
    messageId: expectString(object["messageId"], "lease.messageId"),
    nodeId: expectString(object["nodeId"], "lease.nodeId"),
    expectedGeneration: expectInteger(
      object["expectedGeneration"],
      "lease.expectedGeneration",
    ),
    createdAt: expectString(object["createdAt"], "lease.createdAt"),
  };
}

function requiredJson(
  object: JsonObject,
  key: string,
  label: string,
): JsonValue {
  const value = object[key];
  if (value === undefined) {
    throw new Error(`${label}.${key} is required`);
  }
  return value;
}
