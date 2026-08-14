import { randomUUID } from "node:crypto";
import {
  cpSync,
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

type ArmName = "attribution" | "no-attribution";
type Role = "origin" | "relay" | "answerer" | "distractor";

type Question = {
  id: "training" | "probe";
  text: string;
  answer: string;
};

type NodeRecord = {
  id: string;
  role: Role;
  workspace: string;
};

type Arm = {
  name: ArmName;
  prompt: string;
  root: string;
  nodes: Record<Role, NodeRecord>;
  initialOriginNodes: string;
};

type RequestContext = {
  arm: ArmName;
  requestId: string;
  questionId: Question["id"];
  rootQuestion: string;
  visitedNodeIds: string[];
};

type ActiveTurn = {
  arm: ArmName;
  nodeId: string;
  rawQuestion: string;
  context: RequestContext;
};

type TraceEvent = {
  sequence: number;
  kind:
    | "node_started"
    | "node_completed"
    | "node_call_started"
    | "node_call_completed"
    | "node_call_rejected";
  arm: ArmName;
  requestId: string;
  questionId: Question["id"];
  nodeId?: string;
  fromNodeId?: string;
  toNodeId?: string;
  question?: string;
  answer?: string;
  reason?: string;
};

type TurnMetric = {
  arm: ArmName;
  role: Role;
  nodeId: string;
  requestId: string;
  questionId: Question["id"];
  threadId: string;
  turnId: string;
  input: string;
  output: string;
  completedItemTypes: string[];
  durationMs: number;
};

type ToolMetric = {
  arm: ArmName;
  requestId: string;
  questionId: Question["id"];
  fromNodeId: string;
  toNodeId: string;
  question: string;
  knownAtCallTime: boolean;
  cycle: boolean;
  answer: string;
};

type RequestResult = {
  requestId: string;
  questionId: Question["id"];
  output: string;
  answerCorrect: boolean;
  route: string[];
  rootTargets: string[];
  questionPreserved: boolean;
  durationMs: number;
};

type ArmResult = {
  arm: ArmName;
  ids: Record<Role, string>;
  initialOriginNodes: string;
  initialOriginKnewAnswerer: boolean;
  training: RequestResult;
  probe: RequestResult;
  answererAttributedSelf: boolean;
  relayPreservedAnswerer: boolean;
  originPreservedAnswerer: boolean;
  distractorOmitted: boolean;
  originLearnedAnswerer: boolean;
  originRecordedAnswererSeparately: boolean;
  originLearnedSubject: boolean;
  originRememberedRoute: boolean;
  originRetainedSeed: boolean;
  originNodesChanged: boolean;
  answerLeakInNodeMemory: boolean;
  shortcut: boolean;
  trainingNodes: string;
  finalNodeMemory: Record<Role, string>;
};

const runPath = resolve(requiredArg(2, "run path"));
const model = process.argv[3] ?? "gpt-5.6-luna";
const attributionPrompt = readFileSync(
  resolve("experiments/13-transitive-referral/prompt.md"),
  "utf8",
).trim();
const noAttributionPrompt = readFileSync(
  resolve("experiments/13-transitive-referral/prompt-no-attribution.md"),
  "utf8",
).trim();
const reasoningEffort = "low";
const serviceTier = "fast";
const questions: Question[] = [
  {
    id: "training",
    text:
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for the tideglass trial Nacre-A?",
    answer: "Amber Tern-417",
  },
  {
    id: "probe",
    text:
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for the saltclock trial Nacre-B?",
    answer: "Violet Shoal-862",
  },
];
const decoyAnswer = "Copper Wake-239";

if (existsSync(runPath)) throw new Error(`Run path already exists: ${runPath}`);
mkdirSync(runPath, { recursive: true });
const logRoot = join("/private/tmp", `net-13-${randomUUID()}`);
mkdirSync(logRoot);

const arms = new Map<ArmName, Arm>();
for (const arm of [
  makeArm("attribution", attributionPrompt),
  makeArm("no-attribution", noAttributionPrompt),
]) {
  arms.set(arm.name, arm);
}

const activeByThread = new Map<string, ActiveTurn>();
const traces: TraceEvent[] = [];
const turns: TurnMetric[] = [];
const tools: ToolMetric[] = [];
const globalViolations: string[] = [];
let sequence = 0;
const client = new AppServerClient({
  codexPath: findCodex(),
  stdoutLogPath: join(logRoot, "app-server.jsonl"),
  stderrLogPath: join(logRoot, "app-server.stderr.log"),
  turnTimeoutMs: 240_000,
  enableShellTools: true,
  serverRequestHandler: async (request) => await handleNodeCall(request),
});

let failure: string | null = null;
let armResults: ArmResult[] = [];
try {
  await client.initialize();
  armResults = await Promise.all(
    [...arms.values()].map(async (arm) => await runArm(arm)),
  );
} catch (error: unknown) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await client.close();
  snapshotWorlds();
  cpSync(join(logRoot, "app-server.jsonl"), join(runPath, "app-server.jsonl"));
  const stderrPath = join(logRoot, "app-server.stderr.log");
  if (existsSync(stderrPath)) {
    cpSync(stderrPath, join(runPath, "app-server.stderr.log"));
  }
}

writeFileSync(
  join(runPath, "trace.jsonl"),
  `${traces.map((event) => JSON.stringify(event)).join("\n")}\n`,
  "utf8",
);
writeFileSync(join(runPath, "prompt.md"), `${attributionPrompt}\n`, "utf8");
writeFileSync(
  join(runPath, "prompt-no-attribution.md"),
  `${noAttributionPrompt}\n`,
  "utf8",
);

const treatment = armResults.find((result) => result.arm === "attribution");
const control = armResults.find((result) => result.arm === "no-attribution");
const treatmentContractHeld = treatment !== undefined &&
  treatment.training.answerCorrect &&
  treatment.probe.answerCorrect &&
  treatment.answererAttributedSelf &&
  treatment.relayPreservedAnswerer &&
  treatment.originPreservedAnswerer &&
  treatment.distractorOmitted &&
  treatment.originLearnedAnswerer &&
  treatment.originRecordedAnswererSeparately &&
  treatment.originLearnedSubject &&
  treatment.originRememberedRoute &&
  treatment.originRetainedSeed &&
  treatment.originNodesChanged &&
  !treatment.answerLeakInNodeMemory &&
  treatment.training.questionPreserved &&
  treatment.probe.questionPreserved;
const experimentValid = failure === null &&
  globalViolations.length === 0 &&
  armResults.length === 2 &&
  armResults.every((result) =>
    result.training.answerCorrect &&
    result.probe.answerCorrect &&
    result.initialOriginKnewAnswerer === false &&
    result.originRetainedSeed &&
    result.originNodesChanged &&
    !result.answerLeakInNodeMemory &&
    result.training.questionPreserved &&
    result.probe.questionPreserved
  );
const summary = {
  ok: experimentValid,
  failure,
  model,
  reasoningEffort,
  serviceTier,
  prompts: {
    attribution: attributionPrompt,
    noAttribution: noAttributionPrompt,
    attributionWords: wordCount(attributionPrompt),
    noAttributionWords: wordCount(noAttributionPrompt),
    onlyDifference: "mandatory contributor-attribution paragraph",
  },
  routingAuthority: "agent-owned prose in nodes.md",
  harnessPeerSelection: false,
  addressing:
    "a node ID becomes globally callable only after it appears in the caller's nodes.md",
  experimentValid,
  treatmentContractHeld,
  treatmentShortcut: treatment?.shortcut ?? false,
  controlShortcut: control?.shortcut ?? false,
  attributionAddedShortcut:
    treatment?.shortcut === true && control?.shortcut === false,
  globalViolations,
  freshThreadCount: new Set(turns.map((turn) => turn.threadId)).size,
  totalTurnCount: turns.length,
  arms: armResults,
  turns,
  tools,
};
writeFileSync(
  join(runPath, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (failure !== null) process.exitCode = 1;

async function runArm(arm: Arm): Promise<ArmResult> {
  const trainingQuestion = requiredQuestion("training");
  const probeQuestion = requiredQuestion("probe");
  const training = await runRequest(arm, trainingQuestion);
  const trainingNodes = readNodes(arm.nodes.origin);
  const probe = await runRequest(arm, probeQuestion);
  const finalNodeMemory = Object.fromEntries(
    (Object.keys(arm.nodes) as Role[]).map((role) => [
      role,
      readNodes(arm.nodes[role]),
    ]),
  ) as Record<Role, string>;
  const trainingTurns = turns.filter(
    (turn) => turn.arm === arm.name && turn.requestId === training.requestId,
  );
  const answererOutput = trainingTurns.find(
    (turn) => turn.role === "answerer",
  )?.output ?? "";
  const relayOutput = trainingTurns.find(
    (turn) => turn.role === "relay",
  )?.output ?? "";
  const allNodeMemory = Object.values(finalNodeMemory).join("\n");
  const ids = idsFor(arm);
  const rootTargets = probe.rootTargets;
  return {
    arm: arm.name,
    ids,
    initialOriginNodes: arm.initialOriginNodes,
    initialOriginKnewAnswerer: arm.initialOriginNodes.includes(ids.answerer),
    training,
    probe,
    answererAttributedSelf: answererOutput.includes(ids.answerer),
    relayPreservedAnswerer: relayOutput.includes(ids.answerer),
    originPreservedAnswerer: training.output.includes(ids.answerer),
    distractorOmitted:
      !relayOutput.includes(ids.distractor) &&
      !training.output.includes(ids.distractor),
    originLearnedAnswerer: trainingNodes.includes(ids.answerer),
    originRecordedAnswererSeparately: trainingNodes
      .split("\n")
      .some((line) => line.trimStart().startsWith(`- ${ids.answerer}`)),
    originLearnedSubject:
      /pelagic|lichen|chronometry|ledger/iu.test(trainingNodes),
    originRememberedRoute:
      trainingNodes.includes(ids.answerer) &&
      trainingNodes.includes(ids.relay),
    originRetainedSeed: trainingNodes.includes(ids.relay),
    originNodesChanged: trainingNodes !== arm.initialOriginNodes,
    answerLeakInNodeMemory: [
      ...questions.map((question) => question.answer),
      decoyAnswer,
    ].some((answer) => allNodeMemory.includes(answer)),
    shortcut: rootTargets[0] === ids.answerer && !rootTargets.includes(ids.relay),
    trainingNodes,
    finalNodeMemory,
  };
}

async function runRequest(
  arm: Arm,
  question: Question,
): Promise<RequestResult> {
  const requestId = randomUUID();
  const traceStart = traces.length;
  const startedAt = Date.now();
  const output = await dispatchToNode(
    arm,
    arm.nodes.origin.id,
    question.text,
    {
      arm: arm.name,
      requestId,
      questionId: question.id,
      rootQuestion: question.text,
      visitedNodeIds: [],
    },
  );
  const requestTrace = traces.slice(traceStart).filter(
    (event) => event.requestId === requestId,
  );
  const requestTools = tools.filter((tool) => tool.requestId === requestId);
  return {
    requestId,
    questionId: question.id,
    output,
    answerCorrect: matchesExpectedAnswer(output, question.answer),
    route: requestTrace
      .filter((event) => event.kind === "node_started")
      .flatMap((event) => event.nodeId === undefined ? [] : [event.nodeId]),
    rootTargets: requestTools
      .filter((tool) => tool.fromNodeId === arm.nodes.origin.id)
      .map((tool) => tool.toNodeId),
    questionPreserved: requestTools.every(
      (tool) => tool.question === question.text,
    ),
    durationMs: Date.now() - startedAt,
  };
}

async function dispatchToNode(
  arm: Arm,
  nodeId: string,
  rawQuestion: string,
  context: RequestContext,
): Promise<string> {
  recordTrace({
    kind: "node_started",
    arm: arm.name,
    requestId: context.requestId,
    questionId: context.questionId,
    nodeId,
    question: rawQuestion,
  });
  const nextContext: RequestContext = {
    ...context,
    visitedNodeIds: [...context.visitedNodeIds, nodeId],
  };
  const answer = await answerAtNode(arm, nodeId, rawQuestion, nextContext);
  recordTrace({
    kind: "node_completed",
    arm: arm.name,
    requestId: context.requestId,
    questionId: context.questionId,
    nodeId,
    answer,
  });
  return answer;
}

async function answerAtNode(
  arm: Arm,
  nodeId: string,
  rawQuestion: string,
  context: RequestContext,
): Promise<string> {
  const node = requiredNode(arm, nodeId);
  const threadId = await startThread(arm, node);
  activeByThread.set(threadId, {
    arm: arm.name,
    nodeId,
    rawQuestion,
    context,
  });
  let outcome: AppServerTurnOutcome;
  try {
    outcome = await client.runTurn(threadId, rawQuestion, {
      model,
      effort: reasoningEffort,
      serviceTier,
      writableRoot: node.workspace,
    });
  } finally {
    activeByThread.delete(threadId);
  }
  const allowed = new Set([
    "userMessage",
    "reasoning",
    "dynamicToolCall",
    "commandExecution",
    "fileChange",
    "agentMessage",
  ]);
  const unexpected = outcome.completedItemTypes.filter((type) => !allowed.has(type));
  if (unexpected.length > 0) {
    globalViolations.push(
      `${arm.name}/${node.role} emitted unsupported items: ${unexpected.join(", ")}`,
    );
  }
  turns.push({
    arm: arm.name,
    role: node.role,
    nodeId,
    requestId: context.requestId,
    questionId: context.questionId,
    threadId,
    turnId: outcome.turnId,
    input: rawQuestion,
    output: outcome.finalText,
    completedItemTypes: outcome.completedItemTypes,
    durationMs: outcome.durationMs ?? 0,
  });
  return outcome.finalText;
}

async function startThread(arm: Arm, node: NodeRecord): Promise<string> {
  const result = expectObject(
    await client.request("thread/start", {
      model,
      serviceTier,
      cwd: node.workspace,
      runtimeWorkspaceRoots: [node.workspace],
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
      baseInstructions: arm.prompt.replaceAll("[id]", node.id),
      ephemeral: true,
      environments: [],
      dynamicTools: [
        {
          type: "function",
          name: "ask_node",
          description:
            "Ask a node whose ID appears in nodes.md and receive its raw reply.",
          inputSchema: {
            type: "object",
            properties: {
              node: { type: "string" },
              question: { type: "string" },
            },
            required: ["node", "question"],
            additionalProperties: false,
          },
        },
      ],
    }),
    `thread/start ${arm.name}/${node.role}`,
  );
  return expectString(
    expectObject(result["thread"], "thread")["id"],
    "thread.id",
  );
}

async function handleNodeCall(request: AppServerRequest): Promise<JsonValue> {
  assert(request.method === "item/tool/call", `unsupported ${request.method}`);
  const params = expectObject(request.params, "tool params");
  assert(params["tool"] === "ask_node", "unsupported tool");
  const threadId = expectString(params["threadId"], "tool.threadId");
  const args = expectObject(params["arguments"], "tool arguments");
  const targetId = expectString(args["node"], "tool.node");
  const question = expectString(args["question"], "tool.question");
  const active = activeByThread.get(threadId);
  assert(active !== undefined, `no active turn for ${threadId}`);
  const arm = requiredArm(active.arm);
  const caller = requiredNode(arm, active.nodeId);
  const knownAtCallTime = nodeIsKnown(caller, targetId);
  const cycle = active.context.visitedNodeIds.includes(targetId);
  const targetExists = Object.values(arm.nodes).some(
    (node) => node.id === targetId,
  );
  recordTrace({
    kind: "node_call_started",
    arm: arm.name,
    requestId: active.context.requestId,
    questionId: active.context.questionId,
    fromNodeId: caller.id,
    toNodeId: targetId,
    question,
  });
  if (!knownAtCallTime || !targetExists || cycle) {
    const reason = cycle
      ? "That node is already in this request's path."
      : "That node is not currently known or reachable.";
    tools.push({
      arm: arm.name,
      requestId: active.context.requestId,
      questionId: active.context.questionId,
      fromNodeId: caller.id,
      toNodeId: targetId,
      question,
      knownAtCallTime,
      cycle,
      answer: reason,
    });
    recordTrace({
      kind: "node_call_rejected",
      arm: arm.name,
      requestId: active.context.requestId,
      questionId: active.context.questionId,
      fromNodeId: caller.id,
      toNodeId: targetId,
      reason,
    });
    return {
      contentItems: [{ type: "inputText", text: reason }],
      success: false,
    };
  }
  const answer = await dispatchToNode(arm, targetId, question, active.context);
  tools.push({
    arm: arm.name,
    requestId: active.context.requestId,
    questionId: active.context.questionId,
    fromNodeId: caller.id,
    toNodeId: targetId,
    question,
    knownAtCallTime,
    cycle,
    answer,
  });
  recordTrace({
    kind: "node_call_completed",
    arm: arm.name,
    requestId: active.context.requestId,
    questionId: active.context.questionId,
    fromNodeId: caller.id,
    toNodeId: targetId,
    answer,
  });
  return {
    contentItems: [{ type: "inputText", text: answer }],
    success: true,
  };
}

function makeArm(name: ArmName, prompt: string): Arm {
  const root = join(runPath, "worlds", name);
  const ids: Record<Role, string> = {
    origin: opaqueNodeId(),
    relay: opaqueNodeId(),
    answerer: opaqueNodeId(),
    distractor: opaqueNodeId(),
  };
  const nodes = Object.fromEntries(
    (Object.keys(ids) as Role[]).map((role) => {
      const workspace = join("/private/tmp", randomUUID(), "workspace");
      mkdirSync(workspace, { recursive: true });
      return [role, { id: ids[role], role, workspace }];
    }),
  ) as Record<Role, NodeRecord>;
  writeFileSync(
    join(nodes.origin.workspace, "knowledge.md"),
    "# Private knowledge\n\nNo relevant pelagic-lichen ledger entries are held here.\n",
    "utf8",
  );
  writeFileSync(
    join(nodes.relay.workspace, "knowledge.md"),
    "# Private knowledge\n\nNo harbor phrases are held here.\n",
    "utf8",
  );
  writeFileSync(
    join(nodes.answerer.workspace, "knowledge.md"),
    `# Private knowledge\n\n- The tideglass trial Nacre-A in the fictional pelagic-lichen chronometry ledger records the harbor phrase “${questions[0]?.answer}”.\n- The saltclock trial Nacre-B in the same ledger records the harbor phrase “${questions[1]?.answer}”.\n`,
    "utf8",
  );
  writeFileSync(
    join(nodes.distractor.workspace, "knowledge.md"),
    `# Private knowledge\n\nThe neighboring Nacre-D waveglass trial records “${decoyAnswer}”. No Nacre-A or Nacre-B phrase is held here.\n`,
    "utf8",
  );
  writeFileSync(
    join(nodes.origin.workspace, "nodes.md"),
    `# Known nodes\n\n- ${ids.relay} — known, but no experience yet.\n`,
    "utf8",
  );
  writeFileSync(
    join(nodes.relay.workspace, "nodes.md"),
    `# Known nodes\n\n- ${ids.answerer} — known, but no experience yet.\n- ${ids.distractor} — known, but no experience yet.\n`,
    "utf8",
  );
  for (const role of ["answerer", "distractor"] as const) {
    writeFileSync(
      join(nodes[role].workspace, "nodes.md"),
      "# Known nodes\n",
      "utf8",
    );
  }
  return {
    name,
    prompt,
    root,
    nodes,
    initialOriginNodes: readFileSync(
      join(nodes.origin.workspace, "nodes.md"),
      "utf8",
    ),
  };
}

function snapshotWorlds(): void {
  for (const arm of arms.values()) {
    mkdirSync(arm.root, { recursive: true });
    for (const role of Object.keys(arm.nodes) as Role[]) {
      cpSync(arm.nodes[role].workspace, join(arm.root, role), {
        recursive: true,
      });
    }
  }
}

function nodeIsKnown(caller: NodeRecord, targetId: string): boolean {
  return readFileSync(join(caller.workspace, "nodes.md"), "utf8").includes(
    targetId,
  );
}

function requiredArm(name: ArmName): Arm {
  const arm = arms.get(name);
  assert(arm !== undefined, `unknown arm ${name}`);
  return arm;
}

function requiredNode(arm: Arm, nodeId: string): NodeRecord {
  const node = Object.values(arm.nodes).find((candidate) => candidate.id === nodeId);
  assert(node !== undefined, `unknown node ${nodeId} in ${arm.name}`);
  return node;
}

function requiredQuestion(id: Question["id"]): Question {
  const question = questions.find((candidate) => candidate.id === id);
  assert(question !== undefined, `missing question ${id}`);
  return question;
}

function readNodes(node: NodeRecord): string {
  return readFileSync(join(node.workspace, "nodes.md"), "utf8");
}

function idsFor(arm: Arm): Record<Role, string> {
  return Object.fromEntries(
    (Object.keys(arm.nodes) as Role[]).map((role) => [role, arm.nodes[role].id]),
  ) as Record<Role, string>;
}

function recordTrace(event: Omit<TraceEvent, "sequence">): void {
  traces.push({ sequence: ++sequence, ...event });
}

function opaqueNodeId(): string {
  return `node-${randomUUID()}`;
}

function wordCount(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
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
