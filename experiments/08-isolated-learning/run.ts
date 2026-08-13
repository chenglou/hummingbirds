import { randomUUID } from "node:crypto";
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

type Question = {
  id: string;
  family: string;
  distance: "train" | "repeat" | "near" | "far" | "unknown";
  owner: string;
  text: string;
  answer: string;
  peerOrder: string[];
};

type Call = {
  peer: string;
  question: string;
  reply: string;
};

type ActiveTurn = {
  question: Question;
  calls: Call[];
};

type TurnResult = {
  arm: "train" | "learned" | "blank" | "counterfactual";
  questionId: string;
  family: string;
  distance: Question["distance"];
  expectedPeer: string;
  firstPeer: string | null;
  firstHopCorrect: boolean;
  calls: number;
  answerCorrect: boolean;
  questionPreserved: boolean;
  output: string;
  routingBefore: string;
  routingAfter: string;
  answerStored: boolean;
  threadId: string;
  turnId: string;
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
if (existsSync(runPath)) throw new Error(`Run path already exists: ${runPath}`);
mkdirSync(runPath, { recursive: true });
writeFileSync(join(runPath, "prompt.md"), `${prompt}\n`, "utf8");

const peerIds = ["node-17", "node-42", "node-68", "node-93"];
const questions = makeQuestions();
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
  const trainWorld = makeWorld("train", "# Routing notes\n");
  for (const question of questions.filter((item) => item.distance === "train")) {
    results.push(await runQuestion("train", trainWorld, question));
  }
  const learnedRouting = readFileSync(join(trainWorld, "routing.md"), "utf8");
  writeFileSync(join(runPath, "learned-routing.md"), learnedRouting, "utf8");
  const counterfactualRouting = swapPeerIds(
    learnedRouting,
    "node-17",
    "node-42",
  );
  writeFileSync(
    join(runPath, "counterfactual-routing.md"),
    counterfactualRouting,
    "utf8",
  );

  const probes = questions.filter((item) => item.distance !== "train");
  for (const question of probes) {
    const learnedWorld = makeWorld(
      `learned-${question.id}`,
      learnedRouting,
    );
    const blankWorld = makeWorld(
      `blank-${question.id}`,
      "# Routing notes\n",
    );
    const [learned, blank] = await Promise.all([
      runQuestion("learned", learnedWorld, question),
      runQuestion("blank", blankWorld, question),
    ]);
    results.push(learned, blank);
  }

  for (const question of probes.filter((item) => item.distance === "near")) {
    const world = makeWorld(
      `counterfactual-${question.id}`,
      counterfactualRouting,
    );
    results.push(await runQuestion("counterfactual", world, question));
  }
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
  arm: TurnResult["arm"],
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
  const firstPeer = active.calls[0]?.peer ?? null;
  return {
    arm,
    questionId: question.id,
    family: question.family,
    distance: question.distance,
    expectedPeer: question.owner,
    firstPeer,
    firstHopCorrect: firstPeer === question.owner,
    calls: active.calls.length,
    answerCorrect: matchesExpectedAnswer(outcome.finalText, question.answer),
    questionPreserved: active.calls.every(
      (call) => call.question === question.text,
    ),
    output: outcome.finalText,
    routingBefore,
    routingAfter,
    answerStored: routingAfter.includes(question.answer),
    threadId,
    turnId: outcome.turnId,
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
  const listed = peerIds.includes(peer);
  const reply = listed && peer === active.question.owner
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
  const probes = results.filter(
    (result) => result.arm === "learned" || result.arm === "blank",
  );
  const byArm = (arm: "learned" | "blank") => {
    const armResults = probes.filter((result) => result.arm === arm);
    const novel = armResults.filter(
      (result) => result.distance === "near" || result.distance === "far",
    );
    const repeats = armResults.filter((result) => result.distance === "repeat");
    return {
      firstHopAccuracy: ratio(armResults, (result) => result.firstHopCorrect),
      repeatFirstHopAccuracy: ratio(repeats, (result) => result.firstHopCorrect),
      novelFirstHopAccuracy: ratio(novel, (result) => result.firstHopCorrect),
      answerAccuracy: ratio(armResults, (result) => result.answerCorrect),
      averageCalls: average(armResults.map((result) => result.calls)),
    };
  };
  const learned = byArm("learned");
  const blank = byArm("blank");
  const counterfactual = results.filter(
    (result) => result.arm === "counterfactual",
  );
  return {
    ok: failure === null,
    failure,
    model,
    reasoningEffort,
    serviceTier,
    prompt,
    promptWords: prompt.split(/\s+/u).length,
    peers: peerIds,
    routingAuthority: "model-owned free-form routing.md",
    harnessPeerSelection: false,
    learned,
    blank,
    generalizationLift:
      learned.novelFirstHopAccuracy - blank.novelFirstHopAccuracy,
    memorizationGap:
      learned.repeatFirstHopAccuracy - learned.novelFirstHopAccuracy,
    counterfactualFirstHops: counterfactual.map((result) => ({
      questionId: result.questionId,
      expectedPeer: result.expectedPeer,
      firstPeer: result.firstPeer,
    })),
    learnedRouting: existsSync(join(runPath, "learned-routing.md"))
      ? readFileSync(join(runPath, "learned-routing.md"), "utf8")
      : "",
    answerLeakCount: results.filter((result) => result.answerStored).length,
    results,
  };
}

function makeQuestions(): Question[] {
  const botanyOrder = ["node-42", "node-68", "node-93", "node-17"];
  const harmonyOrder = ["node-17", "node-68", "node-93", "node-42"];
  const ceramicOrder = ["node-17", "node-42", "node-93", "node-68"];
  return [
    {
      id: "botany-train",
      family: "plant physiology",
      distance: "train",
      owner: "node-17",
      text: "In the fictional plant-physiology notebook, what access phrase is attached to the stomatal-closure trial Aster-A?",
      answer: "Glass Fern-417",
      peerOrder: botanyOrder,
    },
    {
      id: "harmony-train",
      family: "harmonic analysis",
      distance: "train",
      owner: "node-42",
      text: "In the fictional harmony workbook, what access phrase is attached to the deceptive-cadence exercise Lydian-A?",
      answer: "Copper Chime-582",
      peerOrder: harmonyOrder,
    },
    {
      id: "botany-repeat",
      family: "plant physiology",
      distance: "repeat",
      owner: "node-17",
      text: "In the fictional plant-physiology notebook, what access phrase is attached to the stomatal-closure trial Aster-A?",
      answer: "Glass Fern-417",
      peerOrder: botanyOrder,
    },
    {
      id: "harmony-repeat",
      family: "harmonic analysis",
      distance: "repeat",
      owner: "node-42",
      text: "In the fictional harmony workbook, what access phrase is attached to the deceptive-cadence exercise Lydian-A?",
      answer: "Copper Chime-582",
      peerOrder: harmonyOrder,
    },
    {
      id: "botany-near",
      family: "plant physiology",
      distance: "near",
      owner: "node-17",
      text: "Which access phrase was logged for the guard-cell response trial Aster-B in the fictional botany notebook?",
      answer: "Velvet Reed-263",
      peerOrder: botanyOrder,
    },
    {
      id: "harmony-near",
      family: "harmonic analysis",
      distance: "near",
      owner: "node-42",
      text: "Which access phrase was logged for the dominant-resolution exercise Lydian-B in the fictional harmony workbook?",
      answer: "Silver Bell-731",
      peerOrder: harmonyOrder,
    },
    {
      id: "botany-far",
      family: "plant physiology",
      distance: "far",
      owner: "node-17",
      text: "What access phrase accompanies the phloem-loading assay Aster-C in the fictional plant-physiology notebook?",
      answer: "Moss Lantern-844",
      peerOrder: botanyOrder,
    },
    {
      id: "harmony-far",
      family: "harmonic analysis",
      distance: "far",
      owner: "node-42",
      text: "What access phrase accompanies the Neapolitan-chord exercise Lydian-C in the fictional harmony workbook?",
      answer: "Ivory Tempo-196",
      peerOrder: harmonyOrder,
    },
    {
      id: "ceramic-unknown",
      family: "ceramic chemistry",
      distance: "unknown",
      owner: "node-68",
      text: "In the fictional ceramics ledger, what access phrase accompanies the feldspar-flux batch Kiln-A?",
      answer: "Ochre Vessel-355",
      peerOrder: ceramicOrder,
    },
  ];
}

function swapPeerIds(text: string, left: string, right: string): string {
  const marker = `peer-swap-${randomUUID()}`;
  return text.replaceAll(left, marker).replaceAll(right, left).replaceAll(marker, right);
}

function ratio<T>(values: T[], predicate: (value: T) => boolean): number {
  if (values.length === 0) return 0;
  return values.filter(predicate).length / values.length;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
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
