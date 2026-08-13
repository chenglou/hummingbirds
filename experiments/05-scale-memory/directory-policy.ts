/** Pure directory filtering based only on explicit topic mentions. */

export interface DirectoryPeer {
  id: string;
  ownTopic: string;
  advertisedTopics: readonly string[];
}

export interface DirectorySelection {
  /** False means no known topic was explicitly named, so do not restrict. */
  restricted: boolean;
  matchingTopics: string[];
  peerIds: string[];
}

/**
 * Restrict to direct peers that advertise a topic explicitly named in the raw
 * question.  Labels use normalized whole-word/whole-phrase matching, never
 * semantic inference.  Input peer order is retained for deterministic output.
 */
export function selectDirectoryPeers(
  rawQuestion: string,
  knownTopics: readonly string[],
  directPeers: readonly DirectoryPeer[],
): DirectorySelection {
  const normalizedQuestion = normalize(rawQuestion);
  const matchingTopics = knownTopics.filter((topic) =>
    containsNormalizedPhrase(normalizedQuestion, normalize(topic)),
  );
  if (matchingTopics.length === 0) {
    return {
      restricted: false,
      matchingTopics: [],
      peerIds: directPeers.map((peer) => peer.id),
    };
  }

  const matching = new Set(matchingTopics.map(normalize));
  return {
    restricted: true,
    matchingTopics: [...matchingTopics],
    peerIds: directPeers
      .filter((peer) =>
        [peer.ownTopic, ...peer.advertisedTopics].some((topic) =>
          matching.has(normalize(topic)),
        ),
      )
      .map((peer) => peer.id),
  };
}

function containsNormalizedPhrase(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}
