import {
  canonicalStringify,
  expectArray,
  expectBoolean,
  expectObject,
  expectString,
  type JsonValue,
} from "./json.ts";
import type { ProposedTransition, WorkerEnvelope } from "./model.ts";

export function routingSemanticError(
  envelope: WorkerEnvelope,
  proposal: ProposedTransition,
): string | null {
  try {
    validateRoutingSemantics(envelope, proposal);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateRoutingSemantics(
  envelope: WorkerEnvelope,
  proposal: ProposedTransition,
): void {
  const currentState = expectObject(envelope.node.state, "node.state");
  const currentPeers = expectArray(currentState["peers"], "node.state.peers");
  const currentPending = expectObject(
    currentState["pending"] ?? null,
    "node.state.pending",
  );
  const nextState = expectObject(proposal.nextState, "proposal.nextState");
  const nextPeers = expectArray(nextState["peers"], "proposal.nextState.peers");
  const nextPending = expectObject(
    nextState["pending"] ?? null,
    "proposal.nextState.pending",
  );
  const nextCompleted = expectObject(
    nextState["completed"] ?? null,
    "proposal.nextState.completed",
  );
  const result = expectObject(proposal.result, "proposal.result");

  invariant(
    canonicalStringify(currentPeers) === canonicalStringify(nextPeers),
    "peer list changed during a fixed-graph experiment",
  );
  invariant(proposal.outgoing.length <= 1, "only one outgoing message is allowed");
  const peerIds = new Set(
    currentPeers.map((peer, index) =>
      expectString(
        expectObject(peer, `node.state.peers[${index}]`)["id"],
        `node.state.peers[${index}].id`,
      ),
    ),
  );
  for (const outgoing of proposal.outgoing) {
    invariant(peerIds.has(outgoing.to), `outgoing target is not a peer: ${outgoing.to}`);
    validateBody(outgoing.body);
  }

  const incoming = expectObject(envelope.incoming.body, "incoming.body");
  if (incoming["kind"] !== "answer" || incoming["found"] !== true) {
    return;
  }

  const requestId = envelope.incoming.requestId;
  const saved = expectObject(
    currentPending[requestId] ?? null,
    `node.state.pending.${requestId}`,
  );
  const savedCaller = saved["callerId"];
  invariant(
    savedCaller === null || typeof savedCaller === "string",
    `node.state.pending.${requestId}.callerId must be a string or null`,
  );
  const answer = expectString(incoming["answer"], "incoming.body.answer");
  invariant(
    nextPending[requestId] === undefined,
    `proposal must clear pending.${requestId}`,
  );
  const completed = expectObject(
    nextCompleted[requestId] ?? null,
    `proposal.nextState.completed.${requestId}`,
  );
  invariant(
    completed["found"] === true && completed["answer"] === answer,
    `proposal must cache the found answer for ${requestId}`,
  );

  if (savedCaller === null) {
    invariant(
      proposal.outgoing.length === 0,
      "a root receiving a found answer must not send another message",
    );
    invariant(result["status"] === "final", "a root answer must have final status");
    invariant(result["found"] === true, "a root answer must set found true");
    invariant(result["answer"] === answer, "a root answer must return the answer");
    return;
  }

  invariant(
    proposal.outgoing.length === 1,
    "a non-root receiving a found answer must return one message",
  );
  const outgoing = proposal.outgoing[0];
  invariant(outgoing !== undefined, "missing outgoing answer");
  invariant(outgoing.to === savedCaller, "found answer must return to the saved caller");
  const body = expectObject(outgoing.body, "outgoing answer");
  invariant(
    body["kind"] === "answer" &&
      body["found"] === true &&
      body["answer"] === answer,
    "outgoing answer must preserve the found answer",
  );
  invariant(result["status"] !== "final", "only a root may emit a final result");
}

function validateBody(value: JsonValue): void {
  const body = expectObject(value, "outgoing.body");
  const kind = expectString(body["kind"], "outgoing.body.kind");
  invariant(
    body["requestId"] === undefined &&
      body["callerId"] === undefined &&
      body["causationId"] === undefined &&
      body["id"] === undefined,
    "runtime IDs must not appear in an outgoing body",
  );
  if (kind === "question") {
    expectString(body["question"], "outgoing.body.question");
    invariant(
      Object.keys(body).length === 2,
      "a question body must contain only kind and question",
    );
    return;
  }
  invariant(kind === "answer", "outgoing.body.kind must be question or answer");
  const found = expectBoolean(body["found"], "outgoing.body.found");
  if (found) {
    expectString(body["answer"], "outgoing.body.answer");
    invariant(
      Object.keys(body).length === 3,
      "a found answer body must contain only kind, found, and answer",
    );
  } else {
    invariant(
      Object.keys(body).length === 2,
      "a not-found answer body must contain only kind and found",
    );
  }
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
