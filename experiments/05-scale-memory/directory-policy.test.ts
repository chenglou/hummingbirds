import { describe, expect, test } from "bun:test";
import { selectDirectoryPeers } from "./directory-policy.ts";

const topics = ["astral", "public health", "civic"];
const peers = [
  { id: "a", ownTopic: "astral", advertisedTopics: [] },
  { id: "h", ownTopic: "health", advertisedTopics: ["public health"] },
  { id: "c", ownTopic: "civic", advertisedTopics: ["astral"] },
] as const;

describe("selectDirectoryPeers", () => {
  test("restricts to the unique topic advertised by direct peers", () => {
    expect(
      selectDirectoryPeers("What is in the astral memorandum?", topics, peers),
    ).toEqual({
      restricted: true,
      matchingTopics: ["astral"],
      peerIds: ["a", "c"],
    });
  });

  test("unions matching direct peers for multiple explicitly named topics", () => {
    expect(
      selectDirectoryPeers("Compare civic and public-health records.", topics, peers),
    ).toEqual({
      restricted: true,
      matchingTopics: ["public health", "civic"],
      peerIds: ["h", "c"],
    });
  });

  test("leaves all direct peers available when no known topic is named", () => {
    expect(selectDirectoryPeers("What routing token was recorded by the civics office?", topics, peers)).toEqual({
      restricted: false,
      matchingTopics: [],
      peerIds: ["a", "h", "c"],
    });
  });

  test("restricts to no peers when a named topic has no direct advertisement", () => {
    expect(
      selectDirectoryPeers("Is there a civic memorandum?", ["civic"], peers.slice(0, 2)),
    ).toEqual({
      restricted: true,
      matchingTopics: ["civic"],
      peerIds: [],
    });
  });
});
