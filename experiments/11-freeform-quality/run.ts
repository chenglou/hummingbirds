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

type AnswerArm =
  | "feedback-training"
  | "self-training"
  | "feedback-probe"
  | "self-probe"
  | "blank-probe";

type PeerId = "node-17" | "node-42" | "node-68" | "node-93";

type Question = {
  id: string;
  index: number;
  text: string;
  peerText: string;
  answer: string;
  replies: Record<PeerId, string>;
  correctPeers: PeerId[];
  requestedPeer?: PeerId;
};

type PeerCall = {
  peer: PeerId;
  question: string;
  reply: string;
  correct: boolean;
};

type ActiveTurn = {
  question: Question;
  calls: PeerCall[];
};

type AnswerResult = {
  arm: AnswerArm;
  questionId: string;
  index: number;
  firstPeer: PeerId | null;
  calls: PeerCall[];
  answerCorrect: boolean;
  questionPreserved: boolean;
  output: string;
  routingBefore: string;
  routingAfter: string;
  answerStored: boolean;
  threadId: string;
  durationMs: number;
};

type FeedbackResult = {
  questionId: string;
  text: string;
  output: string;
  routingBefore: string;
  routingAfter: string;
  routingChanged: boolean;
  answerStored: boolean;
  threadId: string;
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
const peerIds: PeerId[] = ["node-42", "node-68", "node-93", "node-17"];
const bestPeer: PeerId = "node-17";
const { calibrationQuestions, probeQuestions } = makeQuestions();
const allQuestions = [...calibrationQuestions, ...probeQuestions];
const allReplyTokens = allQuestions.flatMap((question) =>
  peerIds.map((peer) => replyToken(question.replies[peer]))
);

assertRawReplies();
if (existsSync(runPath)) throw new Error(`Run path already exists: ${runPath}`);
mkdirSync(runPath, { recursive: true });
writeFileSync(join(runPath, "prompt.md"), `${prompt}\n`, "utf8");

const activeByThread = new Map<string, ActiveTurn>();
const answerResults: AnswerResult[] = [];
const feedbackResults: FeedbackResult[] = [];
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
  const feedbackWorld = makeWorld("feedback", "# Routing notes\n");
  const selfWorld = makeWorld("self-only", "# Routing notes\n");

  const feedbackSequence = (async () => {
    const answers: AnswerResult[] = [];
    const feedback: FeedbackResult[] = [];
    for (const question of calibrationQuestions) {
      const answer = await runAnswer("feedback-training", feedbackWorld, question);
      answers.push(answer);
      feedback.push(await runFeedback(feedbackWorld, question, answer.calls));
    }
    return { answers, feedback };
  })();
  const selfSequence = (async () => {
    const answers: AnswerResult[] = [];
    for (const question of calibrationQuestions) {
      answers.push(await runAnswer("self-training", selfWorld, question));
    }
    return answers;
  })();
  const [feedbackTraining, selfTraining] = await Promise.all([
    feedbackSequence,
    selfSequence,
  ]);
  answerResults.push(...feedbackTraining.answers, ...selfTraining);
  feedbackResults.push(...feedbackTraining.feedback);

  const learnedRouting = readFileSync(join(feedbackWorld, "routing.md"), "utf8");
  const selfRouting = readFileSync(join(selfWorld, "routing.md"), "utf8");
  writeFileSync(join(runPath, "feedback-routing.md"), learnedRouting, "utf8");
  writeFileSync(join(runPath, "self-only-routing.md"), selfRouting, "utf8");

  for (const question of probeQuestions) {
    const feedbackProbe = makeWorld(
      `probe-feedback-${question.id}`,
      learnedRouting,
    );
    const selfProbe = makeWorld(`probe-self-${question.id}`, selfRouting);
    const blankProbe = makeWorld(`probe-blank-${question.id}`, "# Routing notes\n");
    const results = await Promise.all([
      runAnswer("feedback-probe", feedbackProbe, question),
      runAnswer("self-probe", selfProbe, question),
      runAnswer("blank-probe", blankProbe, question),
    ]);
    answerResults.push(...results);
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

async function runAnswer(
  arm: AnswerArm,
  world: string,
  question: Question,
): Promise<AnswerResult> {
  writePeers(world);
  const routingPath = join(world, "routing.md");
  const routingBefore = readFileSync(routingPath, "utf8");
  const threadId = await startThread(world, true);
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
    index: question.index,
    firstPeer: active.calls[0]?.peer ?? null,
    calls: active.calls,
    answerCorrect: matchesExpectedAnswer(outcome.finalText, question.answer),
    questionPreserved: active.calls.every(
      (call) => call.question === question.peerText,
    ),
    output: outcome.finalText,
    routingBefore,
    routingAfter,
    answerStored: containsAnyReplyToken(routingAfter),
    threadId,
    durationMs: Date.now() - startedAt,
  };
}

async function runFeedback(
  world: string,
  question: Question,
  calls: PeerCall[],
): Promise<FeedbackResult> {
  writePeers(world);
  const routingPath = join(world, "routing.md");
  const routingBefore = readFileSync(routingPath, "utf8");
  const text = feedbackText(question, calls);
  const threadId = await startThread(world, false);
  const startedAt = Date.now();
  const outcome = await client.runTurn(threadId, text, {
    model,
    effort: reasoningEffort,
    serviceTier,
    writableRoot: world,
  });
  const routingAfter = readFileSync(routingPath, "utf8");
  return {
    questionId: question.id,
    text,
    output: outcome.finalText,
    routingBefore,
    routingAfter,
    routingChanged: routingAfter !== routingBefore,
    answerStored: containsAnyReplyToken(routingAfter),
    threadId,
    durationMs: Date.now() - startedAt,
  };
}

async function startThread(world: string, allowPeerCalls: boolean): Promise<string> {
  const dynamicTools: JsonValue[] = allowPeerCalls
    ? [
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
      ]
    : [];
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
      dynamicTools,
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
  const peerText = expectString(args["peer"], "tool.peer");
  assert(isPeer(peerText), `unknown peer ${peerText}`);
  const asked = expectString(args["question"], "tool.question");
  const active = activeByThread.get(threadId);
  assert(active !== undefined, `no active turn for ${threadId}`);
  const reply = active.question.replies[peerText];
  const call: PeerCall = {
    peer: peerText,
    question: asked,
    reply,
    correct: active.question.correctPeers.includes(peerText),
  };
  active.calls.push(call);
  return {
    contentItems: [{ type: "inputText", text: reply }],
    success: true,
  };
}

function feedbackText(question: Question, calls: PeerCall[]): string {
  if (calls.length === 0) {
    return "The later field-log review found no peer response from the previous polar-ocean request to check. No answer is needed.";
  }
  const latestByPeer = new Map<PeerId, PeerCall>();
  for (const call of calls) latestByPeer.set(call.peer, call);
  const findings = [...latestByPeer.values()].map((call) =>
    call.correct
      ? `A later audit of the field log confirmed that the response from ${call.peer} matched the requested entry.`
      : `When the field team tried the response from ${call.peer}, it opened a different record; that response was wrong.`
  );
  return `${findings.join(" ")} This concerns ${subject(question)}. Please remember this experience when choosing peers for similar requests. Do not store the answer itself. No answer is needed now.`;
}

function writePeers(world: string): void {
  writeFileSync(
    join(world, "peers.md"),
    `${peerIds.map((peer) => `- ${peer}`).join("\n")}\n`,
    "utf8",
  );
}

function makeWorld(name: string, routing: string): string {
  const world = join(runPath, "worlds", name);
  mkdirSync(world, { recursive: true });
  writeFileSync(join(world, "routing.md"), routing, "utf8");
  writeFileSync(join(world, "peers.md"), "", "utf8");
  return world;
}

function summarize() {
  const probeSummary = (arm: "feedback-probe" | "self-probe" | "blank-probe") => {
    const values = answerResults
      .filter((result) => result.arm === arm)
      .sort((left, right) => left.index - right.index);
    return {
      bestPeerFirstRate: ratio(values, (result) => result.firstPeer === bestPeer),
      answerAccuracy: ratio(values, (result) => result.answerCorrect),
      averageCalls: average(values.map((result) => result.calls.length)),
      firstPeers: values.map((result) => result.firstPeer),
      calls: values.map((result) => result.calls.length),
    };
  };
  const feedback = probeSummary("feedback-probe");
  const selfOnly = probeSummary("self-probe");
  const blank = probeSummary("blank-probe");
  const threadIds = [
    ...answerResults.map((result) => result.threadId),
    ...feedbackResults.map((result) => result.threadId),
  ];
  const training = answerResults.filter(
    (result) => result.arm === "feedback-training" || result.arm === "self-training",
  );
  return {
    ok: failure === null,
    failure,
    model,
    reasoningEffort,
    serviceTier,
    prompt,
    promptWords: prompt.split(/\s+/u).length,
    peerOrder: peerIds,
    bestPeer,
    peerReplyFormat: "unwrapped ordinary prose",
    agentVisibleOutcomeFormat: "ordinary delayed prose",
    feedback,
    selfOnly,
    blank,
    verifiedFeedbackFirstHopLift:
      feedback.bestPeerFirstRate - selfOnly.bestPeerFirstRate,
    feedbackChanges: feedbackResults.filter((result) => result.routingChanged).length,
    feedbackEvents: feedbackResults.length,
    answerLeakCount: [
      ...answerResults.filter((result) => result.answerStored),
      ...feedbackResults.filter((result) => result.answerStored),
    ].length,
    calibrationAdherence: ratio(training, (result) => {
      const question = calibrationQuestions.find(
        (item) => item.id === result.questionId,
      );
      return question?.requestedPeer === result.firstPeer && result.calls.length === 1;
    }),
    allPeerQuestionsPreserved: answerResults.every(
      (result) => result.questionPreserved,
    ),
    freshThreadCount: new Set(threadIds).size,
    totalThreadCount: threadIds.length,
    feedbackRouting: existsSync(join(runPath, "feedback-routing.md"))
      ? readFileSync(join(runPath, "feedback-routing.md"), "utf8")
      : "",
    selfOnlyRouting: existsSync(join(runPath, "self-only-routing.md"))
      ? readFileSync(join(runPath, "self-only-routing.md"), "utf8")
      : "",
    feedbackResults,
    answerResults,
  };
}

function makeQuestions(): {
  calibrationQuestions: Question[];
  probeQuestions: Question[];
} {
  const calibrationSpecs: Array<{
    id: string;
    entry: string;
    answer: string;
    requestedPeer: PeerId;
    correctPeers: PeerId[];
  }> = [
    {
      id: "calibrate-1",
      entry: "the under-ice chlorophyll survey Pelagic-A",
      answer: "Azure Petrel-184",
      requestedPeer: "node-68",
      correctPeers: ["node-17", "node-42", "node-93"],
    },
    {
      id: "calibrate-2",
      entry: "the brine-channel oxygen survey Pelagic-B",
      answer: "Silver Wake-527",
      requestedPeer: "node-17",
      correctPeers: ["node-17", "node-42"],
    },
    {
      id: "calibrate-3",
      entry: "the winter plankton survey Pelagic-C",
      answer: "Coral Tern-693",
      requestedPeer: "node-42",
      correctPeers: ["node-17", "node-42", "node-93"],
    },
    {
      id: "calibrate-4",
      entry: "the shelf-current survey Pelagic-D",
      answer: "Indigo Shoal-248",
      requestedPeer: "node-93",
      correctPeers: ["node-17", "node-42"],
    },
    {
      id: "calibrate-5",
      entry: "the sea-ice carbon survey Pelagic-E",
      answer: "Amber Gull-816",
      requestedPeer: "node-17",
      correctPeers: ["node-17", "node-93"],
    },
    {
      id: "calibrate-6",
      entry: "the polar nutrient survey Pelagic-F",
      answer: "Verdant Current-351",
      requestedPeer: "node-68",
      correctPeers: ["node-17", "node-42"],
    },
    {
      id: "calibrate-7",
      entry: "the deep-water silica survey Pelagic-G",
      answer: "Copper Albatross-975",
      requestedPeer: "node-93",
      correctPeers: ["node-17", "node-93"],
    },
    {
      id: "calibrate-8",
      entry: "the spring bloom survey Pelagic-H",
      answer: "Ivory Tide-462",
      requestedPeer: "node-42",
      correctPeers: ["node-17", "node-93"],
    },
  ];
  const probeSpecs: Array<{
    id: string;
    entry: string;
    answer: string;
    correctPeers: PeerId[];
  }> = [
    {
      id: "probe-1",
      entry: "the krill-migration survey Pelagic-I",
      answer: "Cobalt Auk-739",
      correctPeers: ["node-17", "node-42"],
    },
    {
      id: "probe-2",
      entry: "the meltwater-density survey Pelagic-J",
      answer: "Scarlet Fjord-205",
      correctPeers: ["node-17", "node-93"],
    },
    {
      id: "probe-3",
      entry: "the benthic-flux survey Pelagic-K",
      answer: "Opal Skua-581",
      correctPeers: ["node-17", "node-42"],
    },
    {
      id: "probe-4",
      entry: "the thermocline-mixing survey Pelagic-L",
      answer: "Golden Sound-864",
      correctPeers: ["node-17", "node-68"],
    },
  ];
  const calibrationQuestions = calibrationSpecs.map((spec, index) =>
    makeQuestion({
      ...spec,
      index: index + 1,
      text: `For this calibration request, ask ${spec.requestedPeer} only, then return its reply. In the fictional polar-ocean field log, what access phrase is recorded for ${spec.entry}?`,
      peerText: `In the fictional polar-ocean field log, what access phrase is recorded for ${spec.entry}?`,
    })
  );
  const probeQuestions = probeSpecs.map((spec, index) =>
    makeQuestion({
      ...spec,
      index: index + 1,
      text: `In the fictional polar-ocean field log, what access phrase is recorded for ${spec.entry}?`,
      peerText: `In the fictional polar-ocean field log, what access phrase is recorded for ${spec.entry}?`,
    })
  );
  return { calibrationQuestions, probeQuestions };
}

function makeQuestion(spec: {
  id: string;
  index: number;
  entry: string;
  text: string;
  peerText: string;
  answer: string;
  correctPeers: PeerId[];
  requestedPeer?: PeerId;
}): Question {
  const replies = Object.fromEntries(
    peerIds.map((peer, peerIndex) => {
      const token = spec.correctPeers.includes(peer)
        ? spec.answer
        : decoyToken(spec.index, peerIndex);
      return [
        peer,
        `For ${spec.entry}, I read the field log's access phrase as “${token}”.`,
      ];
    }),
  ) as Record<PeerId, string>;
  return {
    id: spec.id,
    index: spec.index,
    text: spec.text,
    peerText: spec.peerText,
    answer: spec.answer,
    replies,
    correctPeers: spec.correctPeers,
    ...(spec.requestedPeer === undefined
      ? {}
      : { requestedPeer: spec.requestedPeer }),
  };
}

function decoyToken(questionIndex: number, peerIndex: number): string {
  const names = ["Bronze Drift", "Quartz Seal", "Moss Channel", "Pearl Gale"];
  return `${names[peerIndex] ?? "Slate Water"}-${questionIndex}${peerIndex}7`;
}

function subject(_question: Question): string {
  return "fictional polar-ocean field-log access-phrase requests";
}

function replyToken(reply: string): string {
  const match = reply.match(/“([^”]+)”/u);
  assert(match?.[1] !== undefined, "raw peer reply lacks a quoted phrase");
  return match[1];
}

function containsAnyReplyToken(text: string): boolean {
  return allReplyTokens.some((token) => text.includes(token));
}

function assertRawReplies(): void {
  for (const question of allQuestions) {
    for (const peer of peerIds) {
      const reply = question.replies[peer];
      assert(!reply.includes("NOT_FOUND"), "sentinel reply is forbidden");
      assert(!reply.trimStart().startsWith("{"), "JSON reply is forbidden");
      assert(!/\b(confidence|status|score)\b/iu.test(reply), "labeled reply is forbidden");
    }
  }
}

function isPeer(value: string): value is PeerId {
  return peerIds.some((peer) => peer === value);
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
