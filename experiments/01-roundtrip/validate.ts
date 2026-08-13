import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RunStore } from "../../src/store.ts";

const runPath = resolve(process.argv[2] ?? "runs/01-roundtrip-v1");
const store = new RunStore(runPath);
store.verify();

const view = store.loadView();
const events = store.events();
const commits = events.filter((event) => event.kind === "turn_committed");
const route = commits.map((event) => event.nodeId);
assertEqual(route, ["a", "b", "c", "b", "a"], "committed route");

const threadIds = [...view.messages.values()].map((entry) => {
  const body = entry.message.body;
  if (body === null || Array.isArray(body) || typeof body !== "object") {
    throw new Error(`Message ${entry.message.id} has a non-object body`);
  }
  return body["threadId"];
});
assert(
  threadIds.every((threadId) => threadId === "roundtrip-001"),
  "every message must preserve roundtrip-001",
);

const finalCommit = commits.at(-1);
if (finalCommit === undefined) {
  throw new Error("Run has no committed turns");
}
const finalResult = finalCommit.result;
assert(
  finalResult !== null &&
    !Array.isArray(finalResult) &&
    typeof finalResult === "object" &&
    finalResult["status"] === "final" &&
    finalResult["threadId"] === "roundtrip-001" &&
    finalResult["answer"] === "Kestrel Nine",
  "A must emit Kestrel Nine and roundtrip-001 as the final result",
);

for (const [nodeId, node] of view.nodes) {
  const state = node.state;
  assert(
    state !== null &&
      !Array.isArray(state) &&
      typeof state === "object" &&
      state["pending"] !== null &&
      !Array.isArray(state["pending"]) &&
      typeof state["pending"] === "object" &&
      Object.keys(state["pending"]).length === 0,
    `${nodeId} must finish with empty pending state`,
  );
}

assert(
  [...view.messages.values()].every((message) => message.status === "done"),
  "all messages must be consumed",
);
assert(
  [...view.attempts.values()].length === 5 &&
    [...view.attempts.values()].every((attempt) => attempt.accepted),
  "all five worker responses must be accepted",
);

const outwardInputs = commits.slice(0, 2).map((commit) =>
  readFileSync(resolve(runPath, "turns", commit.leaseId, "input.json"), "utf8"),
);
assert(
  outwardInputs.every((input) => !input.includes("Kestrel Nine")),
  "A and B must not receive C's private answer on the outward path",
);

const returningBInput = readFileSync(
  resolve(runPath, "turns", commits[3]?.leaseId ?? "", "input.json"),
  "utf8",
);
const returningAInput = readFileSync(
  resolve(runPath, "turns", commits[4]?.leaseId ?? "", "input.json"),
  "utf8",
);
assert(
  returningBInput.includes('"caller":"a"') &&
    returningAInput.includes('"caller":null'),
  "B and A must recover their saved callers from pending state",
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    route,
    answer: "Kestrel Nine",
    turns: commits.length,
    completion: view.completion,
  })}\n`,
);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}
