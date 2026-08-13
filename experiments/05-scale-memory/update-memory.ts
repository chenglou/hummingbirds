import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type JsonValue } from "../../src/json.ts";

interface MemoryEntry {
  kind?: string;
  question?: string;
  peerId: string;
  outcome: "answered" | "exploring" | "tried_without_answer";
}

const runPath = resolve(process.argv[2] ?? "");
const outputPath = resolve(
  process.argv[3] ?? "experiments/05-scale-memory/routing-memory.json",
);
const summary = readObject(join(runPath, "summary.json"));
const manifest = readObject(join(runPath, "manifest.json"));
const question = expectString(summary["question"], "summary.question");
const routingKind = optionalString(
  summary["routingKind"],
  "summary.routingKind",
);
const expectedAnswer = expectString(
  summary["expectedAnswer"],
  "summary.expectedAnswer",
);
const holder = expectString(summary["holder"], "summary.holder");
const origin = expectString(summary["origin"], "summary.origin");
const tools = expectArray(summary["tools"], "summary.tools").map(
  (value, index) => expectObject(value, `summary.tools[${index}]`),
);
const addressToNode = new Map(
  expectArray(manifest["nodes"], "manifest.nodes").map((value, index) => {
    const node = expectObject(value, `manifest.nodes[${index}]`);
    return [
      expectString(node["address"], "manifest node address"),
      expectString(node["id"], "manifest node id"),
    ] as const;
  }),
);
const memory = readExistingMemory(outputPath);
const updates: Array<{
  nodeId: string;
  peerId: string;
  outcome: MemoryEntry["outcome"];
}> = [];

if (summary["ok"] === true) {
  let current = origin;
  const visited = new Set([current]);
  while (current !== holder) {
    const match = tools
      .filter(
        (tool) =>
          tool["nodeId"] === current &&
          tool["success"] === true &&
          typeof tool["answer"] === "string" &&
          canonical(tool["answer"]).includes(canonical(expectedAnswer)),
      )
      .sort(compareEndedAt)[0];
    assert(
      match !== undefined,
      `no answer-bearing outbound call from ${current}`,
    );
    const peerId = peerForTool(match, addressToNode);
    upsert(
      memory,
      current,
      memoryEntry(question, routingKind, peerId, "answered"),
    );
    updates.push({ nodeId: current, peerId, outcome: "answered" });
    current = peerId;
    assert(
      !visited.has(current),
      `successful chain contains a cycle at ${current}`,
    );
    visited.add(current);
  }
} else {
  const calls = [...tools].sort(compareStartedAt);
  for (const [index, tool] of calls.entries()) {
    const nodeId = expectString(tool["nodeId"], "tool.nodeId");
    const peerId = peerForTool(tool, addressToNode);
    const outcome: MemoryEntry["outcome"] =
      index === calls.length - 1 ? "tried_without_answer" : "exploring";
    upsert(memory, nodeId, memoryEntry(question, routingKind, peerId, outcome));
    updates.push({ nodeId, peerId, outcome });
  }
}

writeFileSync(outputPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({ ok: true, answerCorrect: summary["ok"] === true, outputPath, updates })}\n`,
);

function readExistingMemory(path: string): Record<string, MemoryEntry[]> {
  if (!existsSync(path)) return {};
  const object = readObject(path);
  const result: Record<string, MemoryEntry[]> = {};
  for (const [nodeId, value] of Object.entries(object)) {
    const entries = expectArray(value, `memory.${nodeId}`);
    result[nodeId] = entries.map((item, index) => {
      const entry = expectObject(item, `memory.${nodeId}[${index}]`);
      const outcome =
        entry["outcome"] === "not_found"
          ? "tried_without_answer"
          : (entry["outcome"] ?? "answered");
      assert(
        outcome === "answered" ||
          outcome === "exploring" ||
          outcome === "tried_without_answer",
        "memory outcome must be answered, exploring, or tried_without_answer",
      );
      return memoryEntry(
        memoryKey(entry, `memory.${nodeId}[${index}]`),
        entry["kind"] === undefined
          ? undefined
          : expectString(entry["kind"], "memory.kind"),
        expectString(entry["peerId"], "memory.peerId"),
        outcome,
      );
    });
  }
  return result;
}

function upsert(
  memory: Record<string, MemoryEntry[]>,
  nodeId: string,
  entry: MemoryEntry,
): void {
  const entries = memory[nodeId] ?? [];
  memory[nodeId] = [
    ...entries.filter(
      (candidate) =>
        memoryKey(candidate, "memory entry") !==
          memoryKey(entry, "memory entry") || candidate.peerId !== entry.peerId,
    ),
    entry,
  ];
}

function memoryEntry(
  question: string,
  routingKind: string | undefined,
  peerId: string,
  outcome: MemoryEntry["outcome"],
): MemoryEntry {
  return routingKind === undefined
    ? { question, peerId, outcome }
    : { kind: routingKind, peerId, outcome };
}

function memoryKey(
  entry: { [key: string]: JsonValue } | MemoryEntry,
  label: string,
): string {
  const kind = entry["kind"];
  const question = entry["question"];
  assert(
    (typeof kind === "string") !== (typeof question === "string"),
    `${label} must contain exactly one of kind or question`,
  );
  return typeof kind === "string"
    ? kind
    : expectString(question, `${label}.question`);
}

function peerForTool(
  tool: { [key: string]: JsonValue },
  addressToNode: ReadonlyMap<string, string>,
): string {
  const address = expectString(tool["address"], "tool.address");
  const peerId = addressToNode.get(address);
  assert(peerId !== undefined, `unknown peer address ${address}`);
  return peerId;
}

function compareStartedAt(
  left: { [key: string]: JsonValue },
  right: { [key: string]: JsonValue },
): number {
  return expectString(left["startedAt"], "tool.startedAt").localeCompare(
    expectString(right["startedAt"], "tool.startedAt"),
  );
}

function compareEndedAt(
  left: { [key: string]: JsonValue },
  right: { [key: string]: JsonValue },
): number {
  return expectString(left["endedAt"], "tool.endedAt").localeCompare(
    expectString(right["endedAt"], "tool.endedAt"),
  );
}

function canonical(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function readObject(path: string): { [key: string]: JsonValue } {
  return expectObject(
    JSON.parse(readFileSync(path, "utf8")) as JsonValue,
    path,
  );
}

function expectObject(
  value: JsonValue | undefined,
  label: string,
): { [key: string]: JsonValue } {
  if (
    value === null ||
    value === undefined ||
    Array.isArray(value) ||
    typeof value !== "object"
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function expectArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function expectString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  value: JsonValue | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, label);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
