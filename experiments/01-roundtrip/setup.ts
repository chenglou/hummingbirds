import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJson } from "../../src/json.ts";
import { RunStore } from "../../src/store.ts";

const runPath = resolve(process.argv[2] ?? "runs/01-roundtrip-v1");
const runId = process.argv[3] ?? "01-roundtrip-v1";
const experimentRoot = resolve("experiments/01-roundtrip");
const store = new RunStore(runPath);

store.initialize(runId, {
  instructions: readFileSync(resolve("prompts/worker.md"), "utf8"),
  execution: readJson(resolve("examples/worker-execution.json")),
});

for (const nodeId of ["a", "b", "c"]) {
  store.addNodeFromFile(resolve(experimentRoot, "nodes", `${nodeId}.json`));
}

const message = store.enqueue(
  "a",
  readJson(resolve(experimentRoot, "question.json")),
);

process.stdout.write(
  `${JSON.stringify({ runId, runPath, initialMessageId: message.id })}\n`,
);

