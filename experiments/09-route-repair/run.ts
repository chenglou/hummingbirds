import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  AppServerClient,
  type AppServerRequest,
  type AppServerTurnOutcome,
} from "../../src/app-server-client.ts";
import { type JsonValue } from "../../src/json.ts";
import { matchesExpectedAnswer } from "../04-raw-http/answer-match.ts";

type Arm = "learn" | "repair" | "repaired" | "stale";

type Question = {
  id: string;
  owner: string;
  text: string;
  answer: string;
  peerOrder: string[];
};

type PeerCall = {
  peer: string;
  question: string;
  reply: string;
};

type ActiveTurn = {
  question: Question;
  calls: PeerCall[];
};

type TurnResult = {
  arm: Arm;
  questionId: string;
  expectedPeer: string;
  firstPeer: string | null;
  calls: PeerCall[];
  answerCorrect: boolean;
  questionPreserved: boolean;
  output: string;
  routingBefore: string;
  routingAfter: string;
  routingChanged: boolean;
  answerStored: boolean;
  durationMs: number;
};

const runPath = resolve(requiredArg(2, "run path"));
const model = process.argv[3] ?? "gpt-5.6-luna";
const promptPath = resolve(
  process.argv[4] ?? "experiments/08-isolated-learning/prompt.md",
);
const prompt = readFileSync(promptPath, "utf8").trim();
const reasoningEffort = "low";
const serviceTier = "fast";
const oldPeer = "node-17";
const newPeer = "node-68";
const peerIds = ["node-17", "node-42", "node-68", "node-93"];
const questions = makeQuestions();

if (existsSync(runPath)) throw new Error(`Run path already exists: ${runPath}`);
mkdirSync(runPath, { recursive: true });
writeFileSync(join(runPath, "prompt.md"), `${prompt}\n`, "utf8");

const activeByThread = new Map<string, ActiveTurn>();
const results: TurnResult[] = [];
const client = new AppServerClient({
  codexPath: findCodex(),
  stdoutLogPath: join(runPath, "app-server.jsonl"),
  stderrLogPath: join(runPath, "app-server.stderr.log"),
  turnTimeoutMs: 180_000,
  enableShellTools: true,
  serverRequestHandler: async (request) => await handlePeerCall(request),
});

let failure: string | null = null;
try {
  await client.initialize();
  const liveWorld = makeWorld("live", "# Routing notes\n");

  results.push(await runQuestion("learn", liveWorld, questions.learn));
  const staleRouting = readFileSync(join(liveWorld, "routing.md"), "utf8");
  writeFileSync(join(runPath, "stale-routing.md"), staleRouting, "utf8");

  results.push(await runQuestion("repair", liveWorld, questions.repair));
  const repairedRouting = readFileSync(join(liveWorld, "routing.md"), "utf8");
  writeFileSync(join(runPath, "repaired-routing.md"), repairedRouting, "utf8");

  const repairedWorld = makeWorld("verify-repaired", repairedRouting);
  const staleWorld = makeWorld("verify-stale", staleRouting);
  const [repaired, stale] = await Promise.all([
    runQuestion("repaired", repairedWorld, questions.verify),
    runQuestion("stale", staleWorld, questions.verify),
  ]);
  results.push(repaired, stale);
} catch (error: unknown) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await client.close();
}

const summary = summarize();
writeFileSync(
  join(runPath, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (failure !== null) process.exitCode = 1;

async function runQuestion(
  arm: Arm,
  world: string,
  question: Question,
): Promise<TurnResult> {
  writeFileSync(
    join(world, "peers.md"),
    `${question.peerOrder.map((peer) => `- ${peer}`).join("\n")}\n`,
    "utf8",
  );
  const routingPath = join(world, "routing.md");
  const routingBefore = readFileSync(routingPath, "utf8");
  const threadId = await startThread(world);
  const active: ActiveTurn = { question, calls: [] };
  activeByThread.set(threadId, active);
  const startedAt = Date.now();
  let outcome: AppServerTurnOutcome;
  try {
    outcome = await client.runTurn(threadId, question.text, {
      model,
      effort: reasoningEffort,
      serviceTier,
      writableRoot: world,
    });
  } finally {
    activeByThread.delete(threadId);
  }
  const routingAfter = readFileSync(routingPath, "utf8");
  return {
    arm,
    questionId: question.id,
    expectedPeer: question.owner,
    firstPeer: active.calls[0]?.peer ?? null,
    calls: active.calls,
    answerCorrect: matchesExpectedAnswer(outcome.finalText, question.answer),
    questionPreserved: active.calls.every(
      (call) => call.question === question.text,
    ),
    output: outcome.finalText,
    routingBefore,
    routingAfter,
    routingChanged: routingAfter !== routingBefore,
    answerStored: routingAfter.includes(question.answer),
    durationMs: Date.now() - startedAt,
  };
}

async function startThread(world: string): Promise<string> {
  const value = expectObject(
    await client.request("thread/start", {
      model,
      serviceTier,
      cwd: world,
      runtimeWorkspaceRoots: [world],
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: {
        model_reasoning_effort: reasoningEffort,
        service_tier: serviceTier,
        features: {
          fast_mode: true,
          apps: false,
          plugins: false,
          browser_use: false,
          computer_use: false,
          image_generation: false,
          multi_agent: false,
          shell_tool: true,
          unified_exec: true,
        },
        mcp_servers: {
          node_repl: { enabled: false },
          openaiDeveloperDocs: { enabled: false },
        },
      },
      baseInstructions: prompt,
      ephemeral: true,
      environments: [],
      dynamicTools: [
        {
          type: "function",
          name: "ask_peer",
          description: "Ask one peer from peers.md and receive its raw reply.",
          inputSchema: {
            type: "object",
            properties: {
              peer: { type: "string" },
              question: { type: "string" },
            },
            required: ["peer", "question"],
            additionalProperties: false,
          },
        },
      ],
    }),
    "thread/start",
  );
  return expectString(expectObject(value["thread"], "thread")["id"], "thread.id");
}

async function handlePeerCall(request: AppServerRequest): Promise<JsonValue> {
  assert(request.method === "item/tool/call", `unsupported ${request.method}`);
  const params = expectObject(request.params, "tool params");
  assert(params["tool"] === "ask_peer", "unsupported tool");
  const threadId = expectString(params["threadId"], "tool.threadId");
  const args = expectObject(params["arguments"], "tool arguments");
  const peer = expectString(args["peer"], "tool.peer");
  const asked = expectString(args["question"], "tool.question");
  const active = activeByThread.get(threadId);
  assert(active !== undefined, `no active turn for ${threadId}`);
  const reply = peerIds.includes(peer) && peer === active.question.owner
    ? `Answer: ${active.question.answer}`
    : "NOT_FOUND";
  active.calls.push({ peer, question: asked, reply });
  return {
    contentItems: [{ type: "inputText", text: reply }],
    success: true,
  };
}

function makeWorld(name: string, routing: string): string {
  const world = join(runPath, "worlds", name);
  mkdirSync(world, { recursive: true });
  writeFileSync(join(world, "routing.md"), routing, "utf8");
  writeFileSync(join(world, "peers.md"), "", "utf8");
  return world;
}

function summarize() {
  const learn = results.find((result) => result.arm === "learn");
  const repair = results.find((result) => result.arm === "repair");
  const repaired = results.find((result) => result.arm === "repaired");
  const stale = results.find((result) => result.arm === "stale");
  const repairCalls = repair?.calls.map((call) => call.peer) ?? [];
  const pass = failure === null &&
    learn?.answerCorrect === true &&
    learn.routingAfter.includes(oldPeer) &&
    repair?.firstPeer === oldPeer &&
    repairCalls.includes(newPeer) &&
    repair.answerCorrect &&
    repair.routingChanged &&
    repaired?.firstPeer === newPeer &&
    repaired.calls.length === 1 &&
    repaired.answerCorrect &&
    stale?.firstPeer === oldPeer &&
    results.every((result) => !result.answerStored);
  return {
    pass,
    failure,
    model,
    reasoningEffort,
    serviceTier,
    prompt,
    promptWords: prompt.split(/\s+/u).length,
    oldPeer,
    newPeer,
    evidence: {
      firstPostMovePeer: repair?.firstPeer ?? null,
      repairCalls,
      repairedFirstPeer: repaired?.firstPeer ?? null,
      repairedCalls: repaired?.calls.length ?? null,
      staleControlFirstPeer: stale?.firstPeer ?? null,
    },
    answerLeakCount: results.filter((result) => result.answerStored).length,
    results,
  };
}

function makeQuestions(): {
  learn: Question;
  repair: Question;
  verify: Question;
} {
  return {
    learn: {
      id: "estuary-learn",
      owner: oldPeer,
      text: "In the fictional estuary-ecology fieldbook, what access phrase is attached to the salt-marsh root-oxygen survey Delta-A?",
      answer: "Amber Heron-314",
      peerOrder: [oldPeer, "node-42", "node-93", newPeer],
    },
    repair: {
      id: "estuary-first-after-move",
      owner: newPeer,
      text: "Which access phrase was logged for the tidal nutrient-flow survey Delta-B in the fictional estuary-ecology fieldbook?",
      answer: "Cobalt Tern-728",
      peerOrder: ["node-42", "node-93", newPeer, oldPeer],
    },
    verify: {
      id: "estuary-verify-repair",
      owner: newPeer,
      text: "What access phrase accompanies the benthic salinity-response survey Delta-C in the fictional estuary-ecology fieldbook?",
      answer: "Silver Egret-905",
      peerOrder: ["node-42", "node-93", oldPeer, newPeer],
    },
  };
}

function requiredArg(index: number, label: string): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) throw new Error(`missing ${label}`);
  return value;
}

function findCodex(): string {
  const configured = process.env["CODEX_CLI"];
  const candidates = [
    configured,
    "/Applications/ChatGPT (Beta).app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ];
  const found = candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined && existsSync(candidate),
  );
  if (found === undefined) throw new Error("Codex CLI not found");
  return found;
}

function expectObject(
  value: JsonValue | undefined,
  label: string,
): { [key: string]: JsonValue } {
  if (
    value === null ||
    value === undefined ||
    Array.isArray(value) ||
    typeof value !== "object"
  ) {
    throw new Error(`${label} must be an object`);
  }
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
