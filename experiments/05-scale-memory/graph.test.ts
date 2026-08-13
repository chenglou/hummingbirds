import { describe, expect, test } from "bun:test";
import { generateScaleMemoryGraph, peersFor } from "./graph.ts";

describe("generateScaleMemoryGraph", () => {
  test("creates a deterministic 48-node corpus with 24 unique private holders", () => {
    const graph = generateScaleMemoryGraph({ seed: 17 });
    expect(graph).toEqual(generateScaleMemoryGraph({ seed: 17 }));
    expect(graph.nodes).toHaveLength(48);
    expect(graph.questions).toHaveLength(24);
    expect(new Set(graph.questions.map((question) => question.holder)).size).toBe(24);
    for (const question of graph.questions) {
      const [origin, middle, holder] = question.idealRoute;
      expect(question.origin).toBe(origin);
      expect(question.holder).toBe(holder);
      expect(peersFor(graph, origin)).toContain(middle);
      expect(peersFor(graph, middle)).toContain(holder);
      expect(graph.corpusByNode.get(holder)).toContain(
        `Private ${holder.split("-")[0]} memorandum ${Number(question.requestId.slice(-3))}: routing token is ${question.answer}.`,
      );
    }
  });

  test("scales beyond the baseline while retaining unique holders", () => {
    const graph = generateScaleMemoryGraph({ clusterCount: 10, nodesPerCluster: 7, questionCount: 35 });
    expect(graph.nodes).toHaveLength(70);
    expect(new Set(graph.questions.map((question) => question.holder)).size).toBe(35);
  });

  test("creates unseen question pairs that share a route and routing kind", () => {
    const graph = generateScaleMemoryGraph({ variantsPerRoute: 2 });
    expect(graph.questions).toHaveLength(48);
    expect(new Set(graph.questions.map((question) => question.holder)).size).toBe(24);
    for (let index = 0; index < graph.questions.length; index += 2) {
      const training = graph.questions[index];
      const transfer = graph.questions[index + 1];
      expect(training).toBeDefined();
      expect(transfer).toBeDefined();
      expect(training?.idealRoute).toEqual(transfer?.idealRoute);
      expect(training?.routingKind).toBe(transfer?.routingKind);
      expect(training?.question).not.toBe(transfer?.question);
      expect(training?.answer).not.toBe(transfer?.answer);
    }
  });
});
