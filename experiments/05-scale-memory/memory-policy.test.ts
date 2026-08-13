import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateScaleMemoryGraph } from "./graph.ts";
import { inferRoutingKind, selectPeers } from "./memory-policy.ts";

describe("inferRoutingKind", () => {
  const entry = (routingKind: string, peerId = routingKind) => ({
    peerId,
    routingKind,
    outcome: "answered" as const,
  });

  test("matches the generated singular memorandum wording to memoranda", () => {
    expect(
      inferRoutingKind(
        "In the fictional astral memorandum 1-B, what routing token was recorded?",
        [entry("astral memoranda"), entry("ecology memoranda")],
      ),
    ).toBe("astral memoranda");
  });

  test("chooses the unique fully covered kind across distinct local kinds", () => {
    expect(
      inferRoutingKind("Find the ecology watershed field note.", [
        entry("ecology memoranda"),
        entry("ecology watersheds"),
        entry("ecology watersheds", "duplicate-peer"),
      ]),
    ).toBe("ecology watersheds");
  });

  test("returns no kind when the best positive score is tied", () => {
    expect(
      inferRoutingKind("Find the astral record.", [
        entry("astral memoranda"),
        entry("astral ledgers"),
      ]),
    ).toBeUndefined();
  });

  test("returns no kind when no local kind overlaps", () => {
    expect(
      inferRoutingKind("Where is the zebra token?", [
        entry("astral memoranda"),
        entry("ecology watersheds"),
      ]),
    ).toBeUndefined();
  });

  test("does not infer a lone kind from only the generic memorandum word", () => {
    expect(
      inferRoutingKind("Find the ecology memorandum.", [
        entry("astral memoranda"),
      ]),
    ).toBeUndefined();
    expect(
      inferRoutingKind("Find the astral memorandum.", [
        entry("astral memoranda"),
      ]),
    ).toBe("astral memoranda");
  });

  test("matches only the applicable local learned kind across the unseen suite", () => {
    const graph = generateScaleMemoryGraph({ variantsPerRoute: 2 });
    const memory = JSON.parse(
      readFileSync(
        resolve("experiments/05-scale-memory/routing-memory-learned-24.json"),
        "utf8",
      ),
    ) as Record<
      string,
      Array<{ kind: string; peerId: string; outcome: "answered" }>
    >;

    for (const question of graph.questions.filter((item) =>
      item.requestId.endsWith("-b"),
    )) {
      for (const entries of Object.values(memory)) {
        const policyEntries = entries.map((item) => ({
          peerId: item.peerId,
          routingKind: item.kind,
          outcome: item.outcome,
        }));
        const applicable = entries.some(
          (item) => item.kind === question.routingKind,
        );
        expect(inferRoutingKind(question.question, policyEntries)).toBe(
          applicable ? question.routingKind : undefined,
        );
      }
    }
  });
});

describe("selectPeers", () => {
  test("scopes an attempted route to the exact question", () => {
    const selection = selectPeers(
      ["a", "b"],
      [{ peerId: "a", question: "older question", outcome: "tried_without_answer" }],
      { question: "selected question" },
    );

    expect(selection.visiblePeerIds).toEqual(["a", "b"]);
    expect(selection.hiddenPeerIds).toEqual([]);
  });

  test("matches routing kind and ranks answered peers before untried peers", () => {
    const selection = selectPeers(
      ["untried", "negative", "positive"],
      [
        { peerId: "negative", routingKind: "astral-memo", outcome: "tried_without_answer" },
        { peerId: "positive", routingKind: "astral-memo", outcome: "answered" },
      ],
      { question: "memorandum 12", routingKind: "astral-memo" },
    );

    expect(selection.visiblePeerIds).toEqual(["positive", "untried"]);
    expect(selection.hiddenPeerIds).toEqual(["negative"]);
  });

  test("advisory mode orders answered, exploring, then untried peers", () => {
    const selection = selectPeers(
      ["untried", "exploring", "answered", "negative"],
      [
        { peerId: "exploring", question: "selected", outcome: "exploring" },
        { peerId: "answered", question: "selected", outcome: "answered" },
        { peerId: "negative", question: "selected", outcome: "tried_without_answer" },
      ],
      { question: "selected" },
    );

    expect(selection.visiblePeerIds).toEqual(["answered", "exploring", "untried"]);
    expect(selection.hiddenPeerIds).toEqual(["negative"]);
    expect(selection.sidelinedPeerIds).toEqual([]);
  });

  test("returns no model-visible peers when every direct peer was tried", () => {
    const selection = selectPeers(
      ["a", "b"],
      [
        { peerId: "a", question: "selected", outcome: "tried_without_answer" },
        { peerId: "b", question: "selected", outcome: "tried_without_answer" },
      ],
      { question: "selected" },
    );

    expect(selection.visiblePeerIds).toEqual([]);
    expect(selection.hiddenPeerIds).toEqual(["a", "b"]);
  });

  test("uses the latest matching outcome, so an answer supersedes a prior miss", () => {
    const selection = selectPeers(
      ["a", "b"],
      [
        { peerId: "a", question: "selected", outcome: "tried_without_answer" },
        { peerId: "a", question: "selected", outcome: "answered" },
      ],
      { question: "selected" },
    );

    expect(selection.visiblePeerIds).toEqual(["a", "b"]);
    expect(selection.hiddenPeerIds).toEqual([]);
    expect(selection.latestByPeer.get("a")?.outcome).toBe("answered");
  });

  test("hard mode exposes only the highest available known tier", () => {
    const entries = [
      { peerId: "exploring", question: "selected", outcome: "exploring" as const },
      { peerId: "answered", question: "selected", outcome: "answered" as const },
      { peerId: "negative", question: "selected", outcome: "tried_without_answer" as const },
    ];
    const withAnswer = selectPeers(
      ["untried", "exploring", "answered", "negative"], entries,
      { question: "selected", hardKnownRoutes: true },
    );
    const withoutAnswer = selectPeers(
      ["untried", "exploring", "negative"], entries,
      { question: "selected", hardKnownRoutes: true },
    );
    const withoutKnownRoute = selectPeers(
      ["untried", "negative"], entries,
      { question: "selected", hardKnownRoutes: true },
    );

    expect(withAnswer.visiblePeerIds).toEqual(["answered"]);
    expect(withAnswer.sidelinedPeerIds).toEqual(["exploring", "untried"]);
    expect(withAnswer.hiddenPeerIds).toEqual(["negative"]);
    expect(withoutAnswer.visiblePeerIds).toEqual(["exploring"]);
    expect(withoutAnswer.sidelinedPeerIds).toEqual(["untried"]);
    expect(withoutAnswer.hiddenPeerIds).toEqual(["negative"]);
    expect(withoutKnownRoute.visiblePeerIds).toEqual(["untried"]);
    expect(withoutKnownRoute.sidelinedPeerIds).toEqual([]);
    expect(withoutKnownRoute.hiddenPeerIds).toEqual(["negative"]);
  });
});
