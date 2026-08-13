import { describe, expect, test } from "bun:test";
import type { ProposedTransition, WorkerEnvelope } from "../src/model.ts";
import { routingSemanticError } from "../src/routing-contract.ts";

describe("routingSemanticError", () => {
  test("rejects a root that sends a found answer back to its callee", () => {
    const envelope = rootAnswerEnvelope();
    const bad: ProposedTransition = {
      nextState: completedState(),
      outgoing: [
        {
          to: "peer",
          body: { kind: "answer", found: true, answer: "Silver Orchard" },
        },
      ],
      result: { status: "returned" },
    };
    expect(routingSemanticError(envelope, bad)).toContain(
      "root receiving a found answer",
    );
  });

  test("accepts a root final result for a found answer", () => {
    const good: ProposedTransition = {
      nextState: completedState(),
      outgoing: [],
      result: {
        status: "final",
        found: true,
        answer: "Silver Orchard",
      },
    };
    expect(routingSemanticError(rootAnswerEnvelope(), good)).toBeNull();
  });
});

function rootAnswerEnvelope(): WorkerEnvelope {
  return {
    protocolVersion: 3,
    runId: "run",
    leaseId: "lease",
    worker: null,
    node: {
      id: "root",
      generation: 1,
      systemPrompt: "",
      corpus: {},
      state: {
        peers: [{ id: "peer", profile: "catalog" }],
        pending: {
          request: {
            callerId: null,
            question: "What is the gloss?",
            triedPeerIds: ["peer"],
          },
        },
        completed: {},
      },
    },
    incoming: {
      id: "message",
      requestId: "request",
      callerId: "peer",
      to: "root",
      body: { kind: "answer", found: true, answer: "Silver Orchard" },
      causationId: "cause",
    },
    outputContract: {
      nextState: "json",
      outgoing: "array<{to:string,body:json}>",
      result: "json",
    },
  };
}

function completedState(): ProposedTransition["nextState"] {
  return {
    peers: [{ id: "peer", profile: "catalog" }],
    pending: {},
    completed: {
      request: { found: true, answer: "Silver Orchard" },
    },
  };
}
