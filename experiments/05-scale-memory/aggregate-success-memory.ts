import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type JsonValue } from "../../src/json.ts";
import { matchesExpectedAnswer } from "../04-raw-http/answer-match.ts";

export interface RoutingMemoryEntry {
  kind: string;
  peerId: string;
  outcome: "answered";
}

export type RoutingMemory = Record<string, RoutingMemoryEntry[]>;

/**
 * Learns only validated answer-bearing next hops from successful runs.  The
 * serialized memory deliberately excludes questions and answers: a kind is
 * the sole routing subject. In this experiment that kind name is supplied by
 * the run fixture; learning kind names is intentionally still future work.
 */
export function aggregateSuccessfulRuns(
  runPaths: readonly string[],
): RoutingMemory {
  assert(runPaths.length > 0, "provide at least one successful run directory");
  const memory: RoutingMemory = {};
  for (const runPath of runPaths) addRun(memory, resolve(runPath));
  return memory;
}

function addRun(memory: RoutingMemory, runPath: string): void {
  const summary = readObject(join(runPath, "summary.json"));
  const manifest = readObject(join(runPath, "manifest.json"));
  assert(summary["ok"] === true, `${runPath} is not a successful run`);

  const kind = expectString(summary["routingKind"], "summary.routingKind");
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

  const visited = new Set([current]);
  while (current !== holder) {
    const match = tools
      .filter(
        (tool) =>
          tool["nodeId"] === current &&
          tool["success"] === true &&
          typeof tool["answer"] === "string" &&
          matchesExpectedAnswer(tool["answer"], expectedAnswer),
      )
      .sort(compareEndedAt)[0];
    assert(
      match !== undefined,
      `no answer-bearing outbound call from ${current} in ${runPath}`,
    );
    const peerId = addressToNode.get(
      expectString(match["address"], "tool.address"),
    );
    assert(peerId !== undefined, `unknown peer address in ${runPath}`);
    upsert(memory, current, { kind, peerId, outcome: "answered" });
    current = peerId;
    assert(
      !visited.has(current),
      `successful chain contains a cycle at ${current}`,
    );
    visited.add(current);
  }
}

function upsert(
  memory: RoutingMemory,
  nodeId: string,
  entry: RoutingMemoryEntry,
): void {
  const entries = memory[nodeId] ?? [];
  if (
    !entries.some(
      (candidate) =>
        candidate.kind === entry.kind && candidate.peerId === entry.peerId,
    )
  ) {
    memory[nodeId] = [...entries, entry];
  }
}

function compareEndedAt(
  left: { [key: string]: JsonValue },
  right: { [key: string]: JsonValue },
): number {
  return expectString(left["endedAt"], "tool.endedAt").localeCompare(
    expectString(right["endedAt"], "tool.endedAt"),
  );
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

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (import.meta.main) {
  const [output, ...runPaths] = process.argv.slice(2);
  assert(
    output !== undefined,
    "usage: aggregate-success-memory.ts <output.json> <run-dir>...",
  );
  const outputPath = resolve(output);
  const memory = aggregateSuccessfulRuns(runPaths);
  writeFileSync(outputPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ ok: true, outputPath, runs: runPaths.length, rows: Object.values(memory).flat().length })}\n`,
  );
}
