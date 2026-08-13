/** A deterministic private-memory routing corpus for larger network experiments. */
export interface NodeSpec {
  id: string;
  profile: string;
}

export interface QuestionSpec {
  requestId: string;
  origin: string;
  holder: string;
  question: string;
  answer: string;
  /** Plain-language routing category shared by related unseen questions. */
  routingKind: string;
  /** The intentionally planted, valid three-hop route from origin to holder. */
  idealRoute: readonly [string, string, string];
}

export interface ScaleMemoryGraph {
  nodes: readonly NodeSpec[];
  edges: ReadonlyArray<readonly [string, string]>;
  questions: readonly QuestionSpec[];
  /** Private text that belongs only to the node that holds each answer. */
  corpusByNode: ReadonlyMap<string, readonly string[]>;
}

export interface ScaleMemoryOptions {
  /** Defaults to 8; use 8 x 6 for the baseline 48-node corpus. */
  clusterCount?: number;
  /** Defaults to 6.  Each cluster must have at least three members. */
  nodesPerCluster?: number;
  /** Defaults to 24; every generated question has a distinct answer holder. */
  questionCount?: number;
  /** Defaults to 1; use 2 for a train/test question pair on every route. */
  variantsPerRoute?: number;
  /** Defaults to 20260812.  Equal options always produce equal output. */
  seed?: number;
}

const TOPICS = [
  ["astral", "orbital tables, observatory instruments, and night operations"],
  ["ecology", "field ecology, watersheds, and specimen records"],
  ["civic", "public maps, transit operations, and infrastructure logs"],
  ["heritage", "museum catalogs, oral histories, and provenance notes"],
  ["maritime", "harbor signals, navigation records, and tidal surveys"],
  ["archive", "private ledgers, restoration files, and indexed correspondence"],
  ["geology", "core samples, fault maps, and mineral assay records"],
  ["health", "clinic inventories, field protocols, and public-health reports"],
] as const;

const ROLES = [
  "registry", "fieldwork", "analysis", "operations", "calibration", "archive",
] as const;
const ADJECTIVES = ["Amber", "Cinder", "Ivory", "Juniper", "Lapis", "Sable"] as const;
const NOUNS = ["Beacon", "Cairn", "Harbor", "Lantern", "Orchard", "Violet"] as const;

export function generateScaleMemoryGraph(
  options: ScaleMemoryOptions = {},
): ScaleMemoryGraph {
  const clusterCount = options.clusterCount ?? 8;
  const nodesPerCluster = options.nodesPerCluster ?? 6;
  const questionCount = options.questionCount ?? 24;
  const variantsPerRoute = options.variantsPerRoute ?? 1;
  const totalNodes = clusterCount * nodesPerCluster;
  validate(clusterCount, nodesPerCluster, questionCount, variantsPerRoute);
  const random = mulberry32(options.seed ?? 20_260_812);
  const nodes: NodeSpec[] = [];
  const edges: Array<readonly [string, string]> = [];
  const corpusByNode = new Map<string, string[]>();

  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    for (let member = 0; member < nodesPerCluster; member += 1) {
      const id = nodeId(cluster, member);
      const topic = TOPICS[cluster % TOPICS.length]!;
      const role = ROLES[member % ROLES.length]!;
      nodes.push({ id, profile: `${topic[0]} — ${topic[1]}; ${role} desk` });
      corpusByNode.set(id, []);
      addEdge(edges, id, nodeId(cluster, (member + 1) % nodesPerCluster));
      // Chords make each topical cluster useful without obscuring the planted routes.
      addEdge(edges, id, nodeId(cluster, (member + 2) % nodesPerCluster));
    }
  }

  // Position-preserving bridges form a ring through every topical cluster.
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    for (let member = 0; member < nodesPerCluster; member += 1) {
      addEdge(edges, nodeId(cluster, member), nodeId((cluster + 1) % clusterCount, member));
    }
  }

  const questions: QuestionSpec[] = [];
  const usedHolders = new Set<string>();
  const holderStep = coprimeStep(totalNodes);
  for (let routeIndex = 0; routeIndex < questionCount; routeIndex += 1) {
    const holderOrdinal = (routeIndex * holderStep + 3) % totalNodes;
    const holderCluster = Math.floor(holderOrdinal / nodesPerCluster);
    const member = holderOrdinal % nodesPerCluster;
    const holder = nodeId(holderCluster, member);
    const middle = nodeId((holderCluster - 1 + clusterCount) % clusterCount, member);
    const origin = nodeId((holderCluster - 2 + clusterCount) % clusterCount, member);
    const topic = TOPICS[holderCluster % TOPICS.length]!;
    if (usedHolders.has(holder)) throw new Error("holder schedule must be unique");
    usedHolders.add(holder);
    for (let variant = 0; variant < variantsPerRoute; variant += 1) {
      const suffix =
        variantsPerRoute === 1
          ? ""
          : `-${String.fromCharCode("A".charCodeAt(0) + variant)}`;
      const requestSuffix = suffix.toLocaleLowerCase();
      const memorandum = `${routeIndex + 1}${suffix}`;
      const answer = `${pick(random, ADJECTIVES)} ${pick(random, NOUNS)}-${100 + Math.floor(random() * 900)}`;
      const record = `Private ${topic[0]} memorandum ${memorandum}: routing token is ${answer}.`;
      corpusByNode.get(holder)?.push(record);
      questions.push({
        requestId: `scale-${String(routeIndex + 1).padStart(3, "0")}${requestSuffix}`,
        origin,
        holder,
        question: `In the fictional ${topic[0]} memorandum ${memorandum}, what routing token was recorded?`,
        answer,
        routingKind: `${topic[0]} memoranda`,
        idealRoute: [origin, middle, holder],
      });
    }
  }

  return { nodes, edges, questions, corpusByNode };
}

export function peersFor(graph: Pick<ScaleMemoryGraph, "edges">, node: string): string[] {
  return graph.edges.flatMap(([left, right]) =>
    left === node ? [right] : right === node ? [left] : [],
  );
}

function nodeId(cluster: number, member: number): string {
  return `${TOPICS[cluster % TOPICS.length]![0]}-${String(cluster + 1).padStart(2, "0")}-${String(member + 1).padStart(2, "0")}-${ROLES[member % ROLES.length]!}`;
}

function addEdge(edges: Array<readonly [string, string]>, left: string, right: string): void {
  if (left === right || edges.some(([a, b]) => (a === left && b === right) || (a === right && b === left))) return;
  edges.push([left, right]);
}

function validate(
  clusterCount: number,
  nodesPerCluster: number,
  questionCount: number,
  variantsPerRoute: number,
): void {
  if (!Number.isInteger(clusterCount) || clusterCount < 3) throw new Error("clusterCount must be an integer of at least 3");
  if (!Number.isInteger(nodesPerCluster) || nodesPerCluster < 3) throw new Error("nodesPerCluster must be an integer of at least 3");
  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > clusterCount * nodesPerCluster) {
    throw new Error("questionCount must be between 1 and the total node count");
  }
  if (!Number.isInteger(variantsPerRoute) || variantsPerRoute < 1 || variantsPerRoute > 26) {
    throw new Error("variantsPerRoute must be between 1 and 26");
  }
}

function coprimeStep(total: number): number {
  for (let candidate = 7; candidate < total; candidate += 1) {
    if (greatestCommonDivisor(candidate, total) === 1) return candidate;
  }
  return 1;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("cannot pick from an empty array");
  return value;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
