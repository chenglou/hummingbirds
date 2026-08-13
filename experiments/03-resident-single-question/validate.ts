import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  expectArray,
  expectBoolean,
  expectObject,
  expectString,
} from "../../src/json.ts";
import { RunStore } from "../../src/store.ts";
import {
  nodes,
  peersFor,
  questions,
  type QuestionSpec,
} from "../02-24-node-routing/graph.ts";

const requestId = "route-03";
const question = requiredQuestion(requestId);
const runPath = resolve(process.argv[2] ?? "runs/03-resident-single-question-v1");
const allowOpen = process.argv.includes("--allow-open");
const store = new RunStore(runPath);
store.verify();

const view = store.loadView();
const events = store.events();
const commits = events.filter((event) => event.kind === "turn_committed");
assert(view.nodes.size === nodes.length, `expected ${nodes.length} nodes`);
assert(
  nodes.every((node) => view.nodes.has(node.id)),
  "run must contain every node in the 24-node graph",
);
assert(
  [...view.messages.values()].every((message) => message.status === "done"),
  "every message must be consumed",
);
assert(
  [...view.attempts.values()].filter((attempt) => attempt.accepted).length ===
    commits.length,
  "every committed turn must have one accepted raw attempt",
);
assert(
  !events.some((event) => event.kind === "turn_failed"),
  "the run must have no failed turns",
);

const roots = [...view.messages.values()].filter(
  (entry) => entry.message.causationId === null,
);
assert(roots.length === 1, "run must have exactly one root message");
const root = roots[0]?.message;
assert(root !== undefined, "root message is missing");
assert(root.requestId === question.requestId, "unexpected root request ID");
assert(root.callerId === null, "root message must have a null caller ID");
assert(root.to === question.origin, "root message must target the question origin");
assert(
  [...view.messages.values()].every(
    (entry) => entry.message.requestId === question.requestId,
  ),
  "the run must contain only the benchmark request",
);
for (const node of view.nodes.values()) {
  const corpusContainsAnswer = JSON.stringify(node.definition.corpus).includes(
    question.answer,
  );
  assert(
    corpusContainsAnswer === (node.definition.id === question.holder),
    `private answer placement is wrong for ${node.definition.id}`,
  );
}

const questionCommits = commits.filter((commit) => {
  const incoming = view.messages.get(commit.messageId)?.message;
  return incoming?.requestId === question.requestId;
});
assert(
  questionCommits.length === commits.length,
  "every committed turn must belong to the benchmark request",
);
const route = questionCommits.map((commit) => commit.nodeId);
assert(route.includes(question.holder), `${question.requestId} must reach its holder`);

const finalCommits = questionCommits.filter((commit) => {
  const result = expectObject(commit.result, `${question.requestId} result`);
  return result["status"] === "final";
});
assert(finalCommits.length === 1, `${question.requestId} must have one final result`);
const finalResult = expectObject(
  finalCommits[0]?.result ?? null,
  `${question.requestId} final result`,
);
assert(
  expectBoolean(finalResult["found"], `${question.requestId}.found`),
  `${question.requestId} must be found`,
);
const answer = expectString(finalResult["answer"], `${question.requestId}.answer`);
assert(answer === question.answer, `${question.requestId} answer mismatch`);

const holderIndex = questionCommits.findIndex(
  (commit) => commit.nodeId === question.holder,
);
for (const commit of questionCommits.slice(0, holderIndex)) {
  const input = readFileSync(
    resolve(runPath, "turns", commit.leaseId, "input.json"),
    "utf8",
  );
  assert(
    !input.includes(question.answer),
    `${question.requestId} answer leaked before reaching its holder`,
  );
}

for (const commit of commits) {
  const incoming = view.messages.get(commit.messageId)?.message;
  assert(incoming !== undefined, `missing input message for ${commit.leaseId}`);
  assert(incoming.to === commit.nodeId, "message recipient must execute the turn");
  const peers = new Set(peersFor(commit.nodeId));
  for (const outgoing of commit.outgoing) {
    assert(outgoing.requestId === incoming.requestId, "request ID changed in transit");
    assert(outgoing.callerId === commit.nodeId, "caller ID must be immediate sender");
    assert(outgoing.causationId === incoming.id, "causation link must name input");
    assert(peers.has(outgoing.to), `${commit.nodeId} sent to a non-peer`);
  }
}

const touched = [...view.nodes.values()]
  .filter((node) => node.generation > 0)
  .map((node) => node.definition.id);
const untouched = [...view.nodes.values()]
  .filter((node) => node.generation === 0)
  .map((node) => node.definition.id);
for (const node of view.nodes.values()) {
  const state = expectObject(node.state, `${node.definition.id} state`);
  const pending = expectObject(
    state["pending"] ?? null,
    `${node.definition.id}.pending`,
  );
  assert(Object.keys(pending).length === 0, `${node.definition.id} has pending work`);
  expectArray(state["peers"], `${node.definition.id}.peers`);
}

if (!allowOpen) {
  assert(view.completion?.status === "completed", "run must be explicitly completed");
}

const expectedRoute = [
  ...question.idealRoute,
  question.idealRoute[1],
  question.idealRoute[0],
];
const idealRouteMatch = JSON.stringify(route) === JSON.stringify(expectedRoute);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    virtualAgents: view.nodes.size,
    touchedAgents: touched.length,
    untouchedAgents: untouched,
    requests: 1,
    committedTurns: commits.length,
    rejectedAttempts: [...view.attempts.values()].filter(
      (attempt) => !attempt.accepted,
    ).length,
    idealRouteMatch,
    expectedRoute,
    route,
    answer,
    completion: view.completion,
  })}\n`,
);

function requiredQuestion(id: string): QuestionSpec {
  const match = questions.find((candidate) => candidate.requestId === id);
  if (match === undefined) {
    throw new Error(`Unknown benchmark question: ${id}`);
  }
  return match;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
