import { resolve } from "node:path";
import {
  canonicalStringify,
  expectBoolean,
  expectInteger,
  expectObject,
  expectString,
  type JsonObject,
  type JsonValue,
  readJson,
} from "../../src/json.ts";

export const CONSTANT_CONFIG_KEYS = [
  "model",
  "reasoningEffort",
  "serviceTierRequested",
  "virtualAgents",
  "corpusMode",
  "graphPreset",
  "routingMemoryPath",
  "onePeerPerNodeRequest",
  "hardKnownRoutes",
  "peerTopicAdvertisements",
  "directoryRouting",
  "profilePresentation",
  "memoryProse",
  "routingKindMode",
  "routingKindSource",
  "promptCharacters",
  "promptWords",
  "cache",
  "transitionEnvelope",
  "callerIds",
  "pendingState",
] as const;

export interface SummaryInput {
  path: string;
  summary: JsonValue;
}

export interface NumericAggregate {
  total: number;
  mean: number;
  min: number;
  max: number;
}

export interface AblationReport {
  comparable: boolean;
  count: number;
  requests: {
    unique: number;
    duplicates: string[];
  };
  pass: number;
  passRate: number;
  calls: NumericAggregate;
  turns: NumericAggregate;
  cycles: NumericAggregate;
  blocked: {
    repeat: NumericAggregate;
    hidden: NumericAggregate;
  };
  rawQuestionPreserved: number;
  durationMs: {
    mean: number;
    median: number;
    p90: number;
  };
  configs: {
    constant: JsonObject;
    missing: Record<string, string[]>;
    mixed: Record<string, JsonValue[]>;
  };
}

export function summarizeRuns(inputs: readonly SummaryInput[]): AblationReport {
  if (inputs.length === 0) throw new Error("provide at least one run summary");
  const summaries = inputs.map((input) =>
    expectObject(input.summary, input.path),
  );
  const values = (key: string): number[] =>
    summaries.map((summary, index) =>
      expectInteger(summary[key], `${inputs[index]?.path ?? index}.${key}`),
    );
  const passes = summaries.filter((summary, index) =>
    expectBoolean(summary["ok"], `${inputs[index]?.path ?? index}.ok`),
  ).length;
  const preserved = summaries.filter((summary, index) =>
    expectBoolean(
      summary["rawQuestionPreservedAcrossHops"],
      `${inputs[index]?.path ?? index}.rawQuestionPreservedAcrossHops`,
    ),
  ).length;
  const durations = values("durationMs").sort((left, right) => left - right);
  const configs = auditConfigs(inputs, summaries);
  const requestCounts = new Map<string, number>();
  for (const [index, summary] of summaries.entries()) {
    const requestId = expectString(
      summary["requestId"],
      `${inputs[index]?.path ?? index}.requestId`,
    );
    requestCounts.set(requestId, (requestCounts.get(requestId) ?? 0) + 1);
  }
  const duplicateRequestIds = [...requestCounts]
    .filter(([, count]) => count > 1)
    .map(([requestId]) => requestId)
    .sort();

  return {
    comparable:
      duplicateRequestIds.length === 0 &&
      Object.keys(configs.missing).length === 0 &&
      Object.keys(configs.mixed).length === 0,
    count: inputs.length,
    requests: {
      unique: requestCounts.size,
      duplicates: duplicateRequestIds,
    },
    pass: passes,
    passRate: passes / inputs.length,
    calls: aggregate(values("peerCalls")),
    turns: aggregate(values("modelTurns")),
    cycles: aggregate(values("rejectedCycles")),
    blocked: {
      repeat: aggregate(values("blockedRepeatPeerCalls")),
      hidden: aggregate(values("blockedHiddenPeerCalls")),
    },
    rawQuestionPreserved: preserved,
    durationMs: {
      mean: mean(durations),
      median: nearestRank(durations, 0.5),
      p90: nearestRank(durations, 0.9),
    },
    configs,
  };
}

function aggregate(values: readonly number[]): NumericAggregate {
  return {
    total: values.reduce((total, value) => total + value, 0),
    mean: mean(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Nearest-rank percentiles match the existing experiment-05 reports. */
function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("cannot rank an empty list");
  return value;
}

function auditConfigs(
  inputs: readonly SummaryInput[],
  summaries: readonly JsonObject[],
): AblationReport["configs"] {
  const constant: JsonObject = {};
  const missing: Record<string, string[]> = {};
  const mixed: Record<string, JsonValue[]> = {};

  for (const key of CONSTANT_CONFIG_KEYS) {
    const absent: string[] = [];
    const distinct = new Map<string, JsonValue>();
    for (const [index, summary] of summaries.entries()) {
      if (!Object.hasOwn(summary, key)) {
        absent.push(inputs[index]?.path ?? String(index));
        continue;
      }
      const value = summary[key];
      if (value === undefined) {
        absent.push(inputs[index]?.path ?? String(index));
        continue;
      }
      distinct.set(canonicalStringify(value), value);
    }
    if (absent.length > 0) missing[key] = absent;
    if (distinct.size > 1) mixed[key] = [...distinct.values()];
    if (absent.length === 0 && distinct.size === 1) {
      const value = distinct.values().next().value;
      if (value !== undefined) constant[key] = value;
    }
  }

  return { constant, missing, mixed };
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    throw new Error("usage: bun summarize.ts SUMMARY.json...");
  }
  const inputs = paths.map((path) => {
    const absolute = resolve(path);
    return { path: absolute, summary: readJson(absolute) };
  });
  const report = summarizeRuns(inputs);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.comparable) process.exitCode = 1;
}
