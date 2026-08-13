import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type JsonValue } from "../../src/json.ts";

const runPath = resolve(
  process.argv[2] ?? "runs/04-raw-http-guided-route-05-v1",
);
const outputPath = resolve(
  process.argv[3] ?? "experiments/05-scale-memory/routing-memory.json",
);
const summary = readObject(join(runPath, "summary.json"));
const manifest = readObject(join(runPath, "manifest.json"));
assert(summary["ok"] === true, "can only learn from a correct run");

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
let current = expectString(summary["origin"], "summary.origin");
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
const memory: Record<string, MemoryEntry[]> = {};
const chain = [current];

while (current !== holder) {
  const match = tools
    .filter(
      (tool) =>
        tool["nodeId"] === current &&
        tool["success"] === true &&
        typeof tool["answer"] === "string" &&
        canonical(tool["answer"]).includes(canonical(expectedAnswer)),
    )
    .sort((left, right) =>
      expectString(left["endedAt"], "tool.endedAt").localeCompare(
        expectString(right["endedAt"], "tool.endedAt"),
      ),
    )[0];
  assert(
    match !== undefined,
    `no answer-bearing outbound call from ${current}`,
  );
  const address = expectString(match["address"], "tool.address");
  const peerId = addressToNode.get(address);
  assert(peerId !== undefined, `unknown peer address ${address}`);
  memory[current] = [memoryEntry(question, routingKind, peerId)];
  current = peerId;
  assert(
    !chain.includes(current),
    `successful chain contains a cycle at ${current}`,
  );
  chain.push(current);
}

interface MemoryEntry {
  kind?: string;
  question?: string;
  peerId: string;
  outcome: "answered";
}

function memoryEntry(
  question: string,
  routingKind: string | undefined,
  peerId: string,
): MemoryEntry {
  return routingKind === undefined
    ? { question, peerId, outcome: "answered" }
    : { kind: routingKind, peerId, outcome: "answered" };
}

writeFileSync(outputPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({ ok: true, sourceRun: runPath, outputPath, chain, rows: chain.length - 1 })}\n`,
);

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
