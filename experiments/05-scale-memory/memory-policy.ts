/** Pure, deterministic selection policy for a node's routing memory. */

export type RoutingMemoryOutcome =
  | "answered"
  | "exploring"
  | "tried_without_answer";

/**
 * Entries are append-only observations.  Their order is their recency: a later
 * matching entry for the same peer replaces an earlier one for selection.
 */
export interface RoutingMemoryEntry {
  peerId: string;
  outcome: RoutingMemoryOutcome;
  question?: string;
  routingKind?: string;
}

export interface RoutingMemoryQuery {
  question: string;
  routingKind?: string;
  /** Restrict selection to the best known tier whenever one exists. */
  hardKnownRoutes?: boolean;
}

export interface PeerSelection {
  /** Direct peers exposed to the model, with known successful peers first. */
  visiblePeerIds: string[];
  /** Direct peers excluded because their latest matching attempt had no answer. */
  hiddenPeerIds: string[];
  /** Non-negative peers withheld only by hardKnownRoutes tier selection. */
  sidelinedPeerIds: string[];
  /** Latest matching observation for every direct peer that has one. */
  latestByPeer: ReadonlyMap<string, RoutingMemoryEntry>;
}

/**
 * Infer a routing kind using only kinds already present in this node's local
 * memory. Every normalized kind token must occur in the raw question and the
 * match must be unique; ambiguous or unrelated questions fail closed.
 */
export function inferRoutingKind(
  rawQuestion: string,
  entries: readonly RoutingMemoryEntry[],
): string | undefined {
  const questionTokens = normalizedTokens(rawQuestion);
  const distinctKinds = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.routingKind === undefined ? [] : [entry.routingKind],
      ),
    ),
  ];
  const matches = distinctKinds.filter((kind) => {
    const kindTokens = normalizedTokens(kind);
    return kindTokens.size > 0 &&
      [...kindTokens].every((token) => questionTokens.has(token));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Select model-visible peers without changing the network's transport graph.
 * A memory row applies to an exact question or, when supplied, its routing
 * kind.  Unknown peers are ignored: a memory file cannot create an edge.
 */
export function selectPeers(
  directPeerIds: readonly string[],
  entries: readonly RoutingMemoryEntry[],
  query: RoutingMemoryQuery,
): PeerSelection {
  const directPeers = new Set(directPeerIds);
  const latestByPeer = new Map<string, RoutingMemoryEntry>();

  for (const entry of entries) {
    if (directPeers.has(entry.peerId) && matches(entry, query)) {
      latestByPeer.set(entry.peerId, entry);
    }
  }

  const answered: string[] = [];
  const exploring: string[] = [];
  const untried: string[] = [];
  const hiddenPeerIds: string[] = [];
  for (const peerId of directPeerIds) {
    const latest = latestByPeer.get(peerId);
    if (latest?.outcome === "tried_without_answer") {
      hiddenPeerIds.push(peerId);
    } else if (latest?.outcome === "answered") {
      answered.push(peerId);
    } else if (latest?.outcome === "exploring") {
      exploring.push(peerId);
    } else {
      untried.push(peerId);
    }
  }

  const advisoryPeers = [...answered, ...exploring, ...untried];
  const visiblePeerIds = query.hardKnownRoutes
    ? answered.length > 0
      ? answered
      : exploring.length > 0
        ? exploring
        : untried
    : advisoryPeers;
  const visible = new Set(visiblePeerIds);

  return {
    visiblePeerIds,
    hiddenPeerIds,
    sidelinedPeerIds: advisoryPeers.filter((peerId) => !visible.has(peerId)),
    latestByPeer,
  };
}

function matches(entry: RoutingMemoryEntry, query: RoutingMemoryQuery): boolean {
  return (
    entry.question === query.question ||
    (query.routingKind !== undefined && entry.routingKind === query.routingKind)
  );
}

function normalizedTokens(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[a-z0-9]+/gu) ?? []).map(normalizedToken),
  );
}

function normalizedToken(token: string): string {
  if (token === "memoranda") return "memorandum";
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (
    token.endsWith("s") &&
    token.length > 4 &&
    !token.endsWith("ss") &&
    !token.endsWith("us") &&
    !token.endsWith("is")
  ) {
    return token.slice(0, -1);
  }
  return token;
}
