import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type JsonValue } from "../../src/json.ts";

export interface NodeSpecialization {
  nodeId: string;
  learnedRoutingRows: number;
  distinctKinds: string[];
  appearancesAsIntermediary: number;
  successfulAppearancesAsIntermediary: number;
}

export interface SpecializationReport {
  totals: {
    nodes: number;
    learnedRoutingRows: number;
    distinctKinds: number;
    summaries: number;
    successfulSummaries: number;
    intermediaryAppearances: number;
    successfulIntermediaryAppearances: number;
  };
  nodes: NodeSpecialization[];
  topHubs: NodeSpecialization[];
}

interface MutableNodeSpecialization {
  learnedRoutingRows: number;
  distinctKinds: Set<string>;
  appearancesAsIntermediary: number;
  successfulAppearancesAsIntermediary: number;
}

/**
 * Summarize positive routing memory and observed routes. Failed routing-memory
 * rows do not count as learned specialization. A route's origin and holder are
 * excluded from intermediary counts.
 */
export function analyzeSpecialization(
  memoryValue: JsonValue,
  summaryValues: readonly JsonValue[] = [],
  topLimit = 10,
): SpecializationReport {
  if (!Number.isInteger(topLimit) || topLimit < 0) {
    throw new Error("topLimit must be a non-negative integer");
  }

  const metrics = new Map<string, MutableNodeSpecialization>();
  const memory = expectObject(memoryValue, "routing memory");
  for (const [nodeId, rawEntries] of Object.entries(memory)) {
    const node = nodeMetrics(metrics, nodeId);
    const entries = expectArray(rawEntries, `routing memory.${nodeId}`);
    for (const [index, rawEntry] of entries.entries()) {
      const entry = expectObject(
        rawEntry,
        `routing memory.${nodeId}[${index}]`,
      );
      expectString(entry["peerId"], `routing memory.${nodeId}[${index}].peerId`);
      if (!isPositiveMemoryOutcome(entry["outcome"])) continue;
      node.learnedRoutingRows += 1;
      const kind = optionalString(
        entry["kind"] ?? entry["routingKind"],
        `routing memory.${nodeId}[${index}].kind`,
      );
      if (kind !== undefined) node.distinctKinds.add(kind);
    }
  }

  let successfulSummaries = 0;
  for (const [summaryIndex, summaryValue] of summaryValues.entries()) {
    const summary = expectObject(summaryValue, `summary[${summaryIndex}]`);
    const route = expectArray(summary["route"], `summary[${summaryIndex}].route`)
      .map((value, routeIndex) =>
        expectString(value, `summary[${summaryIndex}].route[${routeIndex}]`),
      );
    for (const nodeId of route) nodeMetrics(metrics, nodeId);
    const successful = summary["ok"] === true;
    if (successful) successfulSummaries += 1;
    for (const nodeId of route.slice(1, -1)) {
      const node = nodeMetrics(metrics, nodeId);
      node.appearancesAsIntermediary += 1;
      if (successful) node.successfulAppearancesAsIntermediary += 1;
    }
  }

  const nodes = [...metrics.entries()]
    .map(([nodeId, value]): NodeSpecialization => ({
      nodeId,
      learnedRoutingRows: value.learnedRoutingRows,
      distinctKinds: [...value.distinctKinds].sort(),
      appearancesAsIntermediary: value.appearancesAsIntermediary,
      successfulAppearancesAsIntermediary:
        value.successfulAppearancesAsIntermediary,
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const topHubs = [...nodes]
    .filter(
      (node) =>
        node.appearancesAsIntermediary > 0 || node.learnedRoutingRows > 0,
    )
    .sort(compareHubs)
    .slice(0, topLimit);
  const allKinds = new Set(nodes.flatMap((node) => node.distinctKinds));

  return {
    totals: {
      nodes: nodes.length,
      learnedRoutingRows: sum(nodes, (node) => node.learnedRoutingRows),
      distinctKinds: allKinds.size,
      summaries: summaryValues.length,
      successfulSummaries,
      intermediaryAppearances: sum(
        nodes,
        (node) => node.appearancesAsIntermediary,
      ),
      successfulIntermediaryAppearances: sum(
        nodes,
        (node) => node.successfulAppearancesAsIntermediary,
      ),
    },
    nodes,
    topHubs,
  };
}

function compareHubs(
  left: NodeSpecialization,
  right: NodeSpecialization,
): number {
  return (
    right.successfulAppearancesAsIntermediary -
      left.successfulAppearancesAsIntermediary ||
    right.appearancesAsIntermediary - left.appearancesAsIntermediary ||
    right.learnedRoutingRows - left.learnedRoutingRows ||
    right.distinctKinds.length - left.distinctKinds.length ||
    left.nodeId.localeCompare(right.nodeId)
  );
}

function isPositiveMemoryOutcome(value: JsonValue | undefined): boolean {
  if (value === undefined || value === "answered") return true;
  if (value === "not_found" || value === "tried_without_answer") return false;
  throw new Error(`unknown routing-memory outcome: ${JSON.stringify(value)}`);
}

function nodeMetrics(
  metrics: Map<string, MutableNodeSpecialization>,
  nodeId: string,
): MutableNodeSpecialization {
  const current = metrics.get(nodeId);
  if (current !== undefined) return current;
  const created: MutableNodeSpecialization = {
    learnedRoutingRows: 0,
    distinctKinds: new Set(),
    appearancesAsIntermediary: 0,
    successfulAppearancesAsIntermediary: 0,
  };
  metrics.set(nodeId, created);
  return created;
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function readJson(path: string): JsonValue {
  return JSON.parse(readFileSync(path, "utf8")) as JsonValue;
}

function summaryPath(path: string): string {
  const absolute = resolve(path);
  return statSync(absolute).isDirectory() ? join(absolute, "summary.json") : absolute;
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

if (import.meta.main) {
  const memoryPath = process.argv[2];
  if (memoryPath === undefined) {
    throw new Error(
      "Usage: bun analyze-specialization.ts MEMORY.json [SUMMARY.json|RUN_DIR ...]",
    );
  }
  const summaries = process.argv.slice(3).map((path) => readJson(summaryPath(path)));
  const report = analyzeSpecialization(readJson(resolve(memoryPath)), summaries);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
