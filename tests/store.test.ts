import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashJson, type JsonValue } from "../src/json.ts";
import type { NodeDefinition } from "../src/model.ts";
import { RunStore, reduceEvents } from "../src/store.ts";

describe("RunStore", () => {
  test("runs a relay and rebuilds identical state from the event log", () => {
    const store = makeStore();
    addNode(store, "a");
    addNode(store, "b");
    store.enqueue("a", { path: [] });

    const first = store.leaseNext("worker-1");
    expect(first?.node.id).toBe("a");
    if (first === null) {
      throw new Error("Expected first lease");
    }
    store.commit(first.leaseId, {
      nextState: { turns: 1 },
      outgoing: [{ to: "b", body: { path: ["a"] } }],
      result: { forwarded: true },
    });

    const second = store.leaseNext("worker-2");
    expect(second?.node.id).toBe("b");
    expect(second?.incoming.requestId).toBe(first.incoming.requestId);
    expect(second?.incoming.callerId).toBe("a");
    if (second === null) {
      throw new Error("Expected second lease");
    }
    store.commit(second.leaseId, {
      nextState: { turns: 1 },
      outgoing: [],
      result: { path: ["a", "b"] },
    });

    const before = store.inspect();
    const replayed = reduceEvents(store.events());
    const replaySummary: JsonValue = {
      run: replayed.run,
      completion: replayed.completion,
      nodes: [...replayed.nodes.values()].map((node) => ({
        id: node.definition.id,
        generation: node.generation,
        state: node.state,
      })),
      messages: [...replayed.messages.values()].map((message) => ({
        ...message.message,
        status: message.status,
      })),
      leases: [...replayed.leases.values()].map((lease) => ({
        ...lease.lease,
        status: lease.status,
      })),
      attempts: [...replayed.attempts.values()],
    } as unknown as JsonValue;
    expect(hashJson(replaySummary)).toBe(hashJson(before));
    store.rebuildSnapshots();
    expect(() => store.verify()).not.toThrow();
  });

  test("prevents concurrent turns for one node and rejects duplicate commits", () => {
    const store = makeStore();
    addNode(store, "a");
    store.enqueue("a", { order: 1 });
    store.enqueue("a", { order: 2 });

    const first = store.leaseNext("worker-1");
    if (first === null) {
      throw new Error("Expected a lease");
    }
    expect(store.leaseNext("worker-2")).toBeNull();
    const proposal = {
      nextState: { turns: 1 },
      outgoing: [],
      result: { ok: true },
    };
    store.commit(first.leaseId, proposal);
    expect(() => store.commit(first.leaseId, proposal)).toThrow(
      "Lease is not active",
    );
    expect(store.leaseNext("worker-2")?.node.generation).toBe(1);
  });

  test("turn input contains only the selected node's corpus", () => {
    const store = makeStore();
    addNode(store, "a", { visible: "ALLOWED_MARKER" });
    addNode(store, "b", { secret: "FORBIDDEN_MARKER" });
    store.enqueue("a", { question: "what can you see?" });

    const envelope = store.leaseNext("fresh-worker");
    if (envelope === null) {
      throw new Error("Expected a lease");
    }
    const serialized = JSON.stringify(envelope);
    expect(serialized).toContain("fresh disposable worker");
    expect(serialized).toContain("gpt-test");
    expect(serialized).toContain("ALLOWED_MARKER");
    expect(serialized).not.toContain("FORBIDDEN_MARKER");
  });

  test("detects tampered turn artifacts", () => {
    const store = makeStore();
    addNode(store, "a");
    store.enqueue("a", { value: 1 });
    const envelope = store.leaseNext("worker");
    if (envelope === null) {
      throw new Error("Expected a lease");
    }
    const inputPath = join(store.root, "turns", envelope.leaseId, "input.json");
    writeFileSync(inputPath, '{"tampered":true}\n');
    expect(() => store.verify()).toThrow("Turn input hash mismatch");
    expect(readFileSync(inputPath, "utf8")).toContain("tampered");
  });

  test("preserves rejected raw responses and allows a fresh retry", () => {
    const store = makeStore();
    addNode(store, "a");
    store.enqueue("a", { value: 1 });
    const envelope = store.leaseNext("worker");
    if (envelope === null) {
      throw new Error("Expected a lease");
    }
    const rejectedPath = join(store.root, "rejected.txt");
    writeFileSync(rejectedPath, "not json", "utf8");
    const rejected = store.submitRaw(envelope.leaseId, rejectedPath);
    expect(rejected.accepted).toBeFalse();
    expect(store.loadView().leases.get(envelope.leaseId)?.status).toBe("active");

    const invalidTargetPath = join(store.root, "invalid-target.json");
    writeFileSync(
      invalidTargetPath,
      '{"nextState":{"turns":1},"outgoing":[{"to":"missing","body":{}}],"result":{}}',
      "utf8",
    );
    const invalidTarget = store.submitRaw(envelope.leaseId, invalidTargetPath);
    expect(invalidTarget.accepted).toBeFalse();
    if (invalidTarget.accepted) {
      throw new Error("Expected invalid target to be rejected");
    }
    expect(invalidTarget.error).toContain("unknown node");

    const semanticPath = join(store.root, "semantic.json");
    writeFileSync(
      semanticPath,
      '{"nextState":{"turns":99},"outgoing":[],"result":{}}',
      "utf8",
    );
    const semantic = store.rejectRaw(
      envelope.leaseId,
      semanticPath,
      "semantic contract mismatch",
    );
    expect(semantic.accepted).toBeFalse();
    expect(semantic.error).toBe("semantic contract mismatch");

    const acceptedPath = join(store.root, "accepted.json");
    writeFileSync(
      acceptedPath,
      '{"nextState":{"turns":1},"outgoing":[],"result":{"ok":true}}',
      "utf8",
    );
    const accepted = store.submitRaw(envelope.leaseId, acceptedPath);
    expect(accepted.accepted).toBeTrue();
    expect(store.loadView().attempts.size).toBe(4);
    expect(() => store.verify()).not.toThrow();
  });

  test("records an explicit completion and freezes the run", () => {
    const store = makeStore();
    addNode(store, "a");
    const completion = store.complete("completed", { score: 1 });
    expect(completion.status).toBe("completed");
    expect(() => store.enqueue("a", { late: true })).toThrow(
      "Run is already completed",
    );
    expect(store.inspect()).toMatchObject({
      completion: { status: "completed", summary: { score: 1 } },
    });
  });
});

function makeStore(): RunStore {
  const root = mkdtempSync(join(tmpdir(), "net-meta-test-"));
  const store = new RunStore(root);
  store.initialize("test-run", {
    instructions: "fresh disposable worker",
    execution: { model: "gpt-test", reasoningEffort: "low", tools: [] },
  });
  return store;
}

function addNode(
  store: RunStore,
  id: string,
  corpus: JsonValue = { token: id },
): void {
  const node: NodeDefinition = {
    id,
    systemPrompt: `Test node ${id}`,
    corpus,
    initialState: { turns: 0 },
  };
  store.addNode(node);
}
