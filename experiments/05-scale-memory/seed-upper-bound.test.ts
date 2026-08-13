import { describe, expect, test } from "bun:test";
import { generateScaleMemoryGraph, peersFor } from "./graph.ts";
import { seedOracleUpperBound } from "./seed-upper-bound.ts";

describe("seedOracleUpperBound", () => {
  test("emits one positive kind-only next hop for every ideal-route step", () => {
    const graph = generateScaleMemoryGraph({ variantsPerRoute: 2 });
    const memory = seedOracleUpperBound(graph);
    const rows = Object.entries(memory).flatMap(([nodeId, entries]) =>
      entries.map((entry) => ({ nodeId, ...entry })),
    );

    expect(rows).toHaveLength(48);
    for (const question of graph.questions) {
      const [origin, middle, holder] = question.idealRoute;
      expect(memory[origin]).toContainEqual({
        peerId: middle,
        kind: question.routingKind,
        outcome: "answered",
      });
      expect(memory[middle]).toContainEqual({
        peerId: holder,
        kind: question.routingKind,
        outcome: "answered",
      });
    }
    for (const row of rows) {
      expect(peersFor(graph, row.nodeId)).toContain(row.peerId);
      expect(JSON.stringify(row)).not.toContain('"answer":');
    }
  });
});
