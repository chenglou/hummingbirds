import { describe, expect, test } from "bun:test";
import {
  RawHttpNetwork,
  type RawHttpRequestContext,
} from "../src/raw-http-network.ts";

describe("RawHttpNetwork", () => {
  test("binds isolated real ports and keeps node responses separate", async () => {
    const network = new RawHttpNetwork(
      [
        { id: "a", port: 0, peerIds: ["b"] },
        { id: "b", port: 0, peerIds: ["a", "c"] },
        { id: "c", port: 0, peerIds: ["b"] },
      ],
      async (node, question) => `${node.id}:${question}`,
    );
    try {
      expect(new Set(network.nodeIds()).size).toBe(3);
      expect(new Set(network.nodeIds().map((id) => network.urlFor(id))).size).toBe(
        3,
      );
      const answers = await Promise.all(
        network.nodeIds().map(async (id) => await network.ask(id, "canary")),
      );
      expect(answers.map((answer) => answer.body).sort()).toEqual([
        "a:canary",
        "b:canary",
        "c:canary",
      ]);
    } finally {
      await network.close();
    }
  });

  test("forwards through HTTP and rejects non-peers", async () => {
    let network: RawHttpNetwork | null = null;
    const responder = async (
      node: { id: string },
      question: string,
      context: RawHttpRequestContext,
    ): Promise<string> => {
      if (node.id === "b") return `b:${question}`;
      if (network === null) throw new Error("Network is not ready");
      const reply = await network.forward(
        "a",
        network.urlFor("b"),
        question,
        context,
      );
      return reply.body;
    };
    network = new RawHttpNetwork(
      [
        { id: "a", port: 0, peerIds: ["b"] },
        { id: "b", port: 0, peerIds: ["a"] },
        { id: "c", port: 0, peerIds: [] },
      ],
      responder,
    );
    try {
      expect((await network.ask("a", "hello")).body).toBe("b:hello");
      expect(
        network
          .trace()
          .filter((event) => event.kind === "request_started")
          .map((event) => event.nodeId),
      ).toEqual(["a", "b"]);
      const context: RawHttpRequestContext = {
        requestId: "test",
        nodeId: "a",
        visitedNodeIds: ["a"],
      };
      await expect(
        network.forward("a", network.urlFor("c"), "hello", context),
      ).rejects.toThrow("cannot call non-peer");
    } finally {
      await network.close();
    }
  });

  test("rejects a revisited node before invoking its responder", async () => {
    let calls = 0;
    const network = new RawHttpNetwork(
      [
        { id: "a", port: 0, peerIds: ["b"] },
        { id: "b", port: 0, peerIds: ["a"] },
      ],
      async () => {
        calls += 1;
        return "unexpected";
      },
    );
    try {
      const result = await network.forward(
        "b",
        network.urlFor("a"),
        "loop",
        { requestId: "cycle", nodeId: "b", visitedNodeIds: ["a", "b"] },
      );
      expect(result.status).toBe(508);
      expect(result.ok).toBeFalse();
      expect(calls).toBe(0);
    } finally {
      await network.close();
    }
  });
});
