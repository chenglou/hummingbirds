import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, toJsonValue } from "../../src/json.ts";
import { RunStore } from "../../src/store.ts";
import {
  nodes,
  peersFor,
  profileFor,
  questions,
  type QuestionSpec,
} from "../02-24-node-routing/graph.ts";

const requestId = "route-03";
const question = requiredQuestion(requestId);
const runPath = resolve(process.argv[2] ?? "runs/03-resident-single-question-v1");
const runId = process.argv[3] ?? "03-resident-single-question-v1";
const executionPath = resolve(
  process.argv[4] ??
    "experiments/03-resident-single-question/execution-resident-luna-fast.json",
);
const systemPrompt = readFileSync(
  resolve("experiments/02-24-node-routing/prompt.md"),
  "utf8",
);
const store = new RunStore(runPath);

store.initialize(runId, {
  instructions: readFileSync(resolve("prompts/worker.md"), "utf8"),
  execution: readJson(executionPath),
});

for (const node of nodes) {
  const privateFacts =
    question.holder === node.id
      ? [
          {
            claim: `${question.question} Answer: ${question.answer}`,
            answer: question.answer,
          },
        ]
      : [];
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

const initialMessage = store.enqueue(
  question.origin,
  { kind: "question", question: question.question },
  null,
  question.requestId,
);

process.stdout.write(
  `${JSON.stringify({
    runId,
    runPath,
    virtualAgents: nodes.length,
    question: {
      requestId: initialMessage.requestId,
      messageId: initialMessage.id,
      to: initialMessage.to,
    },
  })}\n`,
);

function requiredQuestion(id: string): QuestionSpec {
  const match = questions.find((candidate) => candidate.requestId === id);
  if (match === undefined) {
    throw new Error(`Unknown benchmark question: ${id}`);
  }
  return match;
}
