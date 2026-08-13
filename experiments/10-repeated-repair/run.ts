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

type Arm = "learn" | "treatment" | "reset";

type Question = {
  id: string;
  trial: number;
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
  trial: number;
  firstPeer: string | null;
  calls: PeerCall[];
  answerCorrect: boolean;
  questionPreserved: boolean;
  output: string;
  routingBefore: string;
  routingAfter: string;
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
const { learnQuestion, postMoveQuestions } = makeQuestions();

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
  const treatmentWorld = makeWorld("treatment", "# Routing notes\n");
  results.push(await runQuestion("learn", treatmentWorld, learnQuestion));
  const staleRouting = readFileSync(join(treatmentWorld, "routing.md"), "utf8");
  writeFileSync(join(runPath, "stale-routing.md"), staleRouting, "utf8");

  const treatmentPromise = (async () => {
    const sequence: TurnResult[] = [];
    for (const question of postMoveQuestions) {
      sequence.push(await runQuestion("treatment", treatmentWorld, question));
    }
    return sequence;
  })();
  const resetPromise = Promise.all(
    postMoveQuestions.map((question) =>
      runQuestion(
        "reset",
        makeWorld(`reset-${question.id}`, staleRouting),
        question,
      )
    ),
  );
  const [treatment, reset] = await Promise.all([
    treatmentPromise,
    resetPromise,
  ]);
  results.push(...treatment, ...reset);
  writeFileSync(
    join(runPath, "final-routing.md"),
    readFileSync(join(treatmentWorld, "routing.md"), "utf8"),
    "utf8",
  );
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
    trial: question.trial,
    firstPeer: active.calls[0]?.peer ?? null,
    calls: active.calls,
    answerCorrect: matchesExpectedAnswer(outcome.finalText, question.answer),
    questionPreserved: active.calls.every(
      (call) => call.question === question.text,
    ),
    output: outcome.finalText,
    routingBefore,
    routingAfter,
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
  const compact = (arm: "treatment" | "reset") =>
    results
      .filter((result) => result.arm === arm)
      .sort((left, right) => left.trial - right.trial)
      .map((result) => ({
        trial: result.trial,
        firstPeer: result.firstPeer,
        calls: result.calls.length,
        answerCorrect: result.answerCorrect,
      }));
  const treatment = compact("treatment");
  const reset = compact("reset");
  const learnedNewFirst = treatment.filter(
    (result) => result.firstPeer === newPeer,
  ).length;
  const resetNewFirst = reset.filter(
    (result) => result.firstPeer === newPeer,
  ).length;
  return {
    ok: failure === null,
    failure,
    model,
    reasoningEffort,
    serviceTier,
    prompt,
    promptWords: prompt.split(/\s+/u).length,
    oldPeer,
    newPeer,
    treatment,
    reset,
    firstNewPeerTrial:
      treatment.find((result) => result.firstPeer === newPeer)?.trial ?? null,
    learnedNewFirst,
    resetNewFirst,
    firstHopLift: (learnedNewFirst - resetNewFirst) / postMoveQuestions.length,
    converged:
      treatment.slice(-2).length === 2 &&
      treatment.slice(-2).every(
        (result) => result.firstPeer === newPeer && result.calls === 1,
      ),
    answerLeakCount: results.filter((result) => result.answerStored).length,
    allQuestionsPreserved: results.every((result) => result.questionPreserved),
    results,
  };
}

function makeQuestions(): {
  learnQuestion: Question;
  postMoveQuestions: Question[];
} {
  return {
    learnQuestion: {
      id: "estuary-learn",
      trial: 0,
      owner: oldPeer,
      text: "In the fictional estuary-ecology fieldbook, what access phrase is attached to the salt-marsh root-oxygen survey Delta-A?",
      answer: "Amber Heron-314",
      peerOrder: ["node-42", "node-93", newPeer, oldPeer],
    },
    postMoveQuestions: [
      {
        id: "estuary-move-1",
        trial: 1,
        owner: newPeer,
        text: "Which access phrase was logged for the tidal nutrient-flow survey Delta-B in the fictional estuary-ecology fieldbook?",
        answer: "Cobalt Tern-728",
        peerOrder: ["node-42", "node-93", newPeer, oldPeer],
      },
      {
        id: "estuary-move-2",
        trial: 2,
        owner: newPeer,
        text: "What access phrase accompanies the benthic salinity-response survey Delta-C in the fictional estuary-ecology fieldbook?",
        answer: "Silver Egret-905",
        peerOrder: ["node-93", newPeer, "node-42", oldPeer],
      },
      {
        id: "estuary-move-3",
        trial: 3,
        owner: newPeer,
        text: "Find the access phrase for the seagrass carbon-uptake survey Delta-D in the fictional estuary-ecology fieldbook.",
        answer: "Verdant Gull-461",
        peerOrder: ["node-42", newPeer, "node-93", oldPeer],
      },
      {
        id: "estuary-move-4",
        trial: 4,
        owner: newPeer,
        text: "In the fictional estuary-ecology fieldbook, what access phrase belongs to the mudflat nitrogen-cycle survey Delta-E?",
        answer: "Indigo Plover-637",
        peerOrder: ["node-93", "node-42", newPeer, oldPeer],
      },
    ],
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
