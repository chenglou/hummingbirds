/**
 * Generates an oracle upper bound for routing experiments.  This is fixture
 * knowledge derived from idealRoute, never evidence learned from a run.
 * It deliberately writes next hops and routing kinds only—never answer text.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  generateScaleMemoryGraph,
  type ScaleMemoryGraph,
} from "./graph.ts";
export interface OracleRoutingMemoryEntry {
  peerId: string;
  kind: string;
  outcome: "answered";
}

export type OracleRoutingMemory = Record<string, OracleRoutingMemoryEntry[]>;

export function seedOracleUpperBound(graph: ScaleMemoryGraph): OracleRoutingMemory {
  const rows: OracleRoutingMemory = {};
  const seen = new Set<string>();
  for (const question of graph.questions) {
    const [origin, middle, holder] = question.idealRoute;
    for (const [nodeId, peerId] of [[origin, middle], [middle, holder]] as const) {
      const key = `${nodeId}\u0000${question.routingKind}\u0000${peerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (rows[nodeId] ??= []).push({
        peerId,
        kind: question.routingKind,
        outcome: "answered",
      });
    }
  }
  return rows;
}

if (import.meta.main) {
  const outputPath = resolve(
    process.argv[2] ?? "experiments/05-scale-memory/routing-memory-scale48-oracle.json",
  );
  // Two variants share each route and kind; deduplication yields one row per hop.
  const graph = generateScaleMemoryGraph({ variantsPerRoute: 2 });
  const memory = seedOracleUpperBound(graph);
  writeFileSync(outputPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ ok: true, oracleUpperBound: true, outputPath, rows: Object.values(memory).flat().length })}\n`,
  );
}
