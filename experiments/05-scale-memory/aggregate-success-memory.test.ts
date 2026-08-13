import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { aggregateSuccessfulRuns } from "./aggregate-success-memory.ts";

const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true });
});

test("aggregates validated kind routes without retaining answers", () => {
  const root = mkdtempSync(join(tmpdir(), "aggregate-success-memory-"));
  tempPaths.push(root);
  const first = writeRun(root, "first", "beta", "gamma", "Secret-A");
  const second = writeRun(root, "second", "delta", "epsilon", "Secret-B");

  const memory = aggregateSuccessfulRuns([first, second]);

  expect(memory).toEqual({
    alpha: [
      { kind: "shared-kind", peerId: "beta", outcome: "answered" },
      { kind: "shared-kind", peerId: "delta", outcome: "answered" },
    ],
    beta: [{ kind: "shared-kind", peerId: "gamma", outcome: "answered" }],
    delta: [{ kind: "shared-kind", peerId: "epsilon", outcome: "answered" }],
  });
  expect(JSON.stringify(memory)).not.toContain("Secret-");
});

test("does not learn from an answer that only extends the expected token", () => {
  const root = mkdtempSync(join(tmpdir(), "aggregate-success-memory-"));
  tempPaths.push(root);
  const path = writeRun(root, "extended", "beta", "gamma", "Harbor-467");
  const summaryPath = join(path, "summary.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    tools: Array<{ answer: string }>;
  };
  summary.tools[0]!.answer = "Harbor-4672";
  writeFileSync(summaryPath, `${JSON.stringify(summary)}\n`);

  expect(() => aggregateSuccessfulRuns([path])).toThrow(
    "no answer-bearing outbound call from alpha",
  );
});

function writeRun(
  root: string,
  name: string,
  middle: string,
  holder: string,
  answer: string,
): string {
  const path = join(root, name);
  mkdirSync(path);
  const nodes = ["alpha", middle, holder].map((id) => ({
    id,
    address: `http://${id}/ask`,
  }));
  writeFileSync(join(path, "manifest.json"), `${JSON.stringify({ nodes })}\n`);
  writeFileSync(
    join(path, "summary.json"),
    `${JSON.stringify({
      ok: true,
      routingKind: "shared-kind",
      expectedAnswer: answer,
      origin: "alpha",
      holder,
      tools: [
        {
          nodeId: "alpha",
          address: `http://${middle}/ask`,
          success: true,
          answer,
          endedAt: "2026-01-01T00:00:01.000Z",
        },
        {
          nodeId: middle,
          address: `http://${holder}/ask`,
          success: true,
          answer,
          endedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    })}\n`,
  );
  return path;
}
