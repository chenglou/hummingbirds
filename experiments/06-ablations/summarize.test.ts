import { describe, expect, test } from "bun:test";
import {
  CONSTANT_CONFIG_KEYS,
  summarizeRuns,
  type SummaryInput,
} from "./summarize.ts";
import { type JsonObject } from "../../src/json.ts";

const config: JsonObject = {
  model: "gpt-5.6-luna",
  reasoningEffort: "low",
  serviceTierRequested: "fast",
  virtualAgents: 48,
  corpusMode: "all",
  graphPreset: "scale48x2",
  routingMemoryPath: null,
  onePeerPerNodeRequest: true,
  hardKnownRoutes: false,
  peerTopicAdvertisements: true,
  directoryRouting: true,
  profilePresentation: "full",
  memoryProse: "show",
  routingKindMode: "fixture",
  routingKindSource: "question fixture metadata",
  promptCharacters: 92,
  promptWords: 18,
  cache: false,
  transitionEnvelope: false,
  callerIds: false,
  pendingState: false,
};

function input(
  path: string,
  metrics: {
    ok: boolean;
    calls: number;
    turns: number;
    cycles: number;
    repeat: number;
    hidden: number;
    preserved: boolean;
    duration: number;
  },
  configOverrides: JsonObject = {},
): SummaryInput {
  return {
    path,
    summary: {
      ...config,
      requestId: path,
      ...configOverrides,
      ok: metrics.ok,
      peerCalls: metrics.calls,
      modelTurns: metrics.turns,
      rejectedCycles: metrics.cycles,
      blockedRepeatPeerCalls: metrics.repeat,
      blockedHiddenPeerCalls: metrics.hidden,
      rawQuestionPreservedAcrossHops: metrics.preserved,
      durationMs: metrics.duration,
    },
  };
}

const firstMetrics = {
  ok: true,
  calls: 2,
  turns: 3,
  cycles: 0,
  repeat: 0,
  hidden: 1,
  preserved: true,
  duration: 100,
};

describe("summarizeRuns", () => {
  test("aggregates outcome, routing, preservation, and timing metrics", () => {
    const report = summarizeRuns([
      input("a.json", firstMetrics),
      input("b.json", {
        ok: false,
        calls: 4,
        turns: 5,
        cycles: 2,
        repeat: 1,
        hidden: 0,
        preserved: false,
        duration: 300,
      }),
    ]);

    expect(report).toMatchObject({
      comparable: true,
      count: 2,
      requests: { unique: 2, duplicates: [] },
      pass: 1,
      passRate: 0.5,
      calls: { total: 6, mean: 3, min: 2, max: 4 },
      turns: { total: 8, mean: 4, min: 3, max: 5 },
      cycles: { total: 2, mean: 1, min: 0, max: 2 },
      blocked: {
        repeat: { total: 1, mean: 0.5, min: 0, max: 1 },
        hidden: { total: 1, mean: 0.5, min: 0, max: 1 },
      },
      rawQuestionPreserved: 1,
      durationMs: { mean: 200, median: 100, p90: 300 },
      configs: { missing: {}, mixed: {} },
    });
    expect(Object.keys(report.configs.constant)).toEqual([
      ...CONSTANT_CONFIG_KEYS,
    ]);
  });

  test("flags a mixed key configuration instead of treating it as constant", () => {
    const report = summarizeRuns([
      input("luna.json", firstMetrics),
      input("terra.json", firstMetrics, { model: "gpt-5.6-terra" }),
    ]);

    expect(report.comparable).toBe(false);
    expect(report.configs.mixed["model"]).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-terra",
    ]);
    expect(report.configs.constant["model"]).toBeUndefined();
  });

  test("flags missing key configurations with their source paths", () => {
    const incomplete = input("old.json", firstMetrics);
    const summary = incomplete.summary as JsonObject;
    delete summary["routingKindMode"];
    const report = summarizeRuns([
      input("new.json", firstMetrics),
      incomplete,
    ]);

    expect(report.comparable).toBe(false);
    expect(report.configs.missing["routingKindMode"]).toEqual(["old.json"]);
    expect(report.configs.constant["routingKindMode"]).toBeUndefined();
  });

  test("flags duplicate request ids", () => {
    const duplicate = input("b.json", firstMetrics, { requestId: "a.json" });
    const report = summarizeRuns([input("a.json", firstMetrics), duplicate]);

    expect(report.comparable).toBe(false);
    expect(report.requests).toEqual({ unique: 1, duplicates: ["a.json"] });
  });

  test("rejects missing run metrics rather than fabricating zeroes", () => {
    const bad = input("bad.json", firstMetrics);
    delete (bad.summary as JsonObject)["blockedHiddenPeerCalls"];

    expect(() => summarizeRuns([bad])).toThrow(
      "bad.json.blockedHiddenPeerCalls",
    );
  });
});
