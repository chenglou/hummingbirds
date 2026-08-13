import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type JsonValue } from "../../src/json.ts";
import { nodes, peersFor, questions } from "../02-24-node-routing/graph.ts";

const runPath = resolve(process.argv[2] ?? "runs/04-raw-http-v1");
const manifest = readObject(join(runPath, "manifest.json"));
const summary = readObject(join(runPath, "summary.json"));
const trace = readJsonLines(join(runPath, "trace.jsonl"));
const appServerOutbound = readFileSync(join(runPath, "app-server.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.startsWith("> "))
  .map((line, index) =>
    expectObject(
      JSON.parse(line.slice(2)) as JsonValue,
      `app-server outbound ${index + 1}`,
    ),
  );
const requestIdValue = summary["requestId"];
const selectedRequestId =
  typeof requestIdValue === "string" ? requestIdValue : "route-03";
const question = questions.find(
  (candidate) => candidate.requestId === selectedRequestId,
);
if (question === undefined) throw new Error(`Unknown request: ${selectedRequestId}`);

assert(summary["ok"] === true, "run summary is not successful");
assert(summary["cache"] === false, "answer cache must be disabled");
assert(summary["transitionEnvelope"] === false, "transition envelope still present");
assert(summary["callerIds"] === false, "caller IDs still present");
assert(summary["pendingState"] === false, "pending state still present");
assert(
  (summary["answerMatchesExpected"] ?? summary["answerContainsExpected"]) === true,
  "answer mismatch",
);
assert(summary["rootStatus"] === 200, "root HTTP status must be 200");
assert(summary["virtualAgents"] === 24, "expected 24 virtual agents");
assert(summary["listeners"] === 24, "expected 24 HTTP listeners");
assert(summary["loadedThreads"] === 24, "expected 24 separate threads");

const manifestNodes = expectArray(manifest["nodes"], "manifest.nodes").map(
  (value, index) => expectObject(value, `manifest.nodes[${index}]`),
);
assert(manifestNodes.length === nodes.length, "manifest node count mismatch");
const addresses = manifestNodes.map((node) =>
  expectString(node["address"], "node.address"),
);
const threadIds = manifestNodes.map((node) =>
  expectString(node["threadId"], "node.threadId"),
);
assert(new Set(addresses).size === nodes.length, "node addresses are not unique");
assert(new Set(threadIds).size === nodes.length, "node threads are not unique");
assert(
  addresses.every(
    (address, index) => address === `http://127.0.0.1:${41_001 + index}/ask`,
  ),
  "ports are not the expected 41001-41024 sequence",
);

const threadStarts = appServerOutbound.filter(
  (message) => message["method"] === "thread/start",
);
assert(threadStarts.length === nodes.length, "expected one thread/start per node");
assert(
  threadStarts.filter((message) => {
    const params = expectObject(message["params"], "thread/start.params");
    return expectString(params["baseInstructions"], "baseInstructions").includes(
      question.answer,
    );
  }).length === 1,
  "the private answer must be sent in exactly one node's permanent context",
);

for (const node of manifestNodes) {
  const nodeId = expectString(node["id"], "node.id");
  const facts = expectArray(node["privateFacts"], `${nodeId}.privateFacts`);
  const serializedFacts = JSON.stringify(facts);
  assert(
    serializedFacts.includes(question.answer) === (nodeId === question.holder),
    `private answer placement is wrong for ${nodeId}`,
  );
}

const requestId = expectString(summary["rootRequestId"], "summary.rootRequestId");
const requestEvents = trace.filter((event) => event["requestId"] === requestId);
const route = requestEvents
  .filter((event) => event["kind"] === "request_started")
  .map((event) => expectString(event["nodeId"], "trace.nodeId"));
assert(route[0] === question.origin, "route did not start at the origin");
assert(route.includes(question.holder), "route never reached the answer holder");

for (const event of requestEvents.filter(
  (candidate) => candidate["kind"] === "peer_call_started",
)) {
  const from = expectString(event["fromNodeId"], "peer call fromNodeId");
  const to = expectString(event["toNodeId"], "peer call toNodeId");
  assert(peersFor(from).includes(to), `${from} called non-peer ${to}`);
}
const rejectedCycles = requestEvents.filter(
  (event) => event["kind"] === "request_rejected",
).length;

const turns = expectArray(summary["turns"], "summary.turns").map(
  (value, index) => expectObject(value, `summary.turns[${index}]`),
);
assert(turns.length === route.length, "one model turn is required per visited node");
for (const turn of turns) {
  const nodeId = expectString(turn["nodeId"], "turn.nodeId");
  const input = expectString(turn["input"], "turn.input");
  const matchingRequest = requestEvents.find(
    (event) =>
      event["kind"] === "request_started" &&
      event["nodeId"] === nodeId &&
      event["question"] === input,
  );
  assert(matchingRequest !== undefined, `${nodeId} model input was not raw HTTP body`);
}
const turnStarts = appServerOutbound.filter(
  (message) => message["method"] === "turn/start",
);
assert(turnStarts.length === turns.length, "app-server turn count mismatch");
for (const message of turnStarts) {
  const params = expectObject(message["params"], "turn/start.params");
  const input = expectArray(params["input"], "turn/start.input");
  assert(input.length === 1, "turn/start must contain one raw text item");
  const textItem = expectObject(input[0], "turn/start.input[0]");
  assert(textItem["type"] === "text", "turn/start input must be text");
  assert(
    expectString(textItem["text"], "turn/start input text") === question.question,
    "model turn input changed the raw question",
  );
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    virtualAgents: nodes.length,
    ports: [41_001, 41_024],
    route,
    modelTurns: turns.length,
    peerCalls: expectArray(summary["tools"], "summary.tools").length,
    answer: summary["answer"],
    durationMs: summary["durationMs"],
    rawQuestionPreservedAcrossHops: summary["rawQuestionPreservedAcrossHops"],
    rejectedCycles,
    promptWords: summary["promptWords"],
  })}\n`,
);

function readObject(path: string): { [key: string]: JsonValue } {
  return expectObject(JSON.parse(readFileSync(path, "utf8")) as JsonValue, path);
}

function readJsonLines(path: string): Array<{ [key: string]: JsonValue }> {
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) return [];
  return text.split("\n").map((line, index) =>
    expectObject(JSON.parse(line) as JsonValue, `${path}:${index + 1}`),
  );
}

function expectObject(
  value: JsonValue | undefined,
  label: string,
): { [key: string]: JsonValue } {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function expectArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function expectString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
