import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, toJsonValue } from "../../src/json.ts";
import { RunStore } from "../../src/store.ts";
import { nodes, peersFor, profileFor, questions } from "./graph.ts";

const runPath = resolve(process.argv[2] ?? "runs/02-24-node-routing-v1");
const runId = process.argv[3] ?? "02-24-node-routing-v1";
const executionPath = resolve(
  process.argv[4] ?? "examples/worker-execution.json",
);
const experimentRoot = resolve("experiments/02-24-node-routing");
const systemPrompt = readFileSync(resolve(experimentRoot, "prompt.md"), "utf8");
const store = new RunStore(runPath);

store.initialize(runId, {
  instructions: readFileSync(resolve("prompts/worker.md"), "utf8"),
  execution: readJson(executionPath),
});

for (const node of nodes) {
  const privateFacts = questions
    .filter((question) => question.holder === node.id)
    .map((question) => ({
      claim: `${question.question} Answer: ${question.answer}`,
      answer: question.answer,
    }));
  const peers = peersFor(node.id).map((peerId) => ({
    id: peerId,
    profile: profileFor(peerId),
  }));
  store.addNode({
    id: node.id,
    systemPrompt,
    corpus: toJsonValue({ profile: node.profile, facts: privateFacts }),
    initialState: toJsonValue({ peers, pending: {}, completed: {} }),
  });
}

const initialMessages = questions.map((question) =>
  store.enqueue(
    question.origin,
    { kind: "question", question: question.question },
    null,
    question.requestId,
  ),
);

process.stdout.write(
  `${JSON.stringify({
    runId,
    runPath,
    virtualAgents: nodes.length,
    questions: initialMessages.map((message) => ({
      requestId: message.requestId,
      messageId: message.id,
      to: message.to,
    })),
  })}\n`,
);
