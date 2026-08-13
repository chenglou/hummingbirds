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
import {
  RawHttpNetwork,
  type RawHttpNodeSpec,
  type RawHttpRequestContext,
} from "../../src/raw-http-network.ts";
import {
  nodes as legacyNodes,
  peersFor as legacyPeersFor,
  questions as legacyQuestions,
} from "../02-24-node-routing/graph.ts";
import {
  generateScaleMemoryGraph,
  peersFor as scaledPeersFor,
} from "../05-scale-memory/graph.ts";
import {
  inferRoutingKind,
  selectPeers,
  type RoutingMemoryEntry as PolicyMemoryEntry,
} from "../05-scale-memory/memory-policy.ts";
import { selectDirectoryPeers } from "../05-scale-memory/directory-policy.ts";
import { matchesExpectedAnswer } from "./answer-match.ts";

const ALLOWED_ITEM_TYPES = new Set([
  "userMessage",
  "reasoning",
  "dynamicToolCall",
  "agentMessage",
]);

const runPath = resolve(process.argv[2] ?? "runs/04-raw-http-v1");
const model = process.argv[6] ?? "gpt-5.6-luna";
const reasoningEffort = "low";
const serviceTier = "fast";
const promptPath = resolve(
  process.argv[3] ?? "experiments/04-raw-http/prompt.md",
);
const prompt = readFileSync(promptPath, "utf8").trim();
const graphPreset = process.argv[7] ?? "legacy";
if (
  graphPreset !== "legacy" &&
  graphPreset !== "scale48" &&
  graphPreset !== "scale48x2"
) {
  throw new Error(
    `Graph preset must be legacy, scale48, or scale48x2: ${graphPreset}`,
  );
}
const scaledGraph =
  graphPreset === "legacy"
    ? null
    : generateScaleMemoryGraph({
        variantsPerRoute: graphPreset === "scale48x2" ? 2 : 1,
      });
const experimentNodes = scaledGraph?.nodes ?? legacyNodes;
const experimentQuestions = scaledGraph?.questions ?? legacyQuestions;
const profileByNode = new Map(
  experimentNodes.map((node) => [node.id, node.profile]),
);
const selectedRequestId =
  process.argv[4] ??
  (graphPreset === "legacy"
    ? "route-03"
    : graphPreset === "scale48x2"
      ? "scale-001-a"
      : "scale-001");
const corpusMode = process.argv[5] ?? "single";
if (corpusMode !== "single" && corpusMode !== "all") {
  throw new Error(`Corpus mode must be single or all: ${corpusMode}`);
}
const execution = JSON.parse(
  readFileSync(resolve("experiments/04-raw-http/execution.json"), "utf8"),
) as JsonValue;
const routingMemoryPath =
  process.argv[8] === undefined ? null : resolve(process.argv[8]);
const routingMemory = readRoutingMemory(routingMemoryPath);
const callPolicy = process.argv[9] ?? "many";
if (callPolicy !== "one" && callPolicy !== "many") {
  throw new Error(`Call policy must be one or many: ${callPolicy}`);
}
const onePeerPerNodeRequest = callPolicy === "one";
const memoryPolicy = process.argv[10] ?? "advisory";
if (memoryPolicy !== "hard" && memoryPolicy !== "advisory") {
  throw new Error(`Memory policy must be hard or advisory: ${memoryPolicy}`);
}
const hardKnownRoutes = memoryPolicy === "hard";
const advertisementPolicy = process.argv[11] ?? "quiet";
if (advertisementPolicy !== "advertise" && advertisementPolicy !== "quiet") {
  throw new Error(
    `Advertisement policy must be advertise or quiet: ${advertisementPolicy}`,
  );
}
const peerTopicAdvertisements = advertisementPolicy === "advertise";
const directoryPolicy = process.argv[12] ?? "open";
if (directoryPolicy !== "directory" && directoryPolicy !== "open") {
  throw new Error(
    `Directory policy must be directory or open: ${directoryPolicy}`,
  );
}
const directoryRouting = directoryPolicy === "directory";
const profilePresentation = process.argv[13] ?? "full";
if (
  profilePresentation !== "full" &&
  profilePresentation !== "topic" &&
  profilePresentation !== "topic-role" &&
  profilePresentation !== "none"
) {
  throw new Error(
    `Profile presentation must be full, topic-role, topic, or none: ${profilePresentation}`,
  );
}
const memoryProse = process.argv[14] ?? "show";
if (memoryProse !== "show" && memoryProse !== "hide") {
  throw new Error(`Memory prose must be show or hide: ${memoryProse}`);
}
const routingKindMode = process.argv[15] ?? "fixture";
if (routingKindMode !== "fixture" && routingKindMode !== "selected-text") {
  throw new Error(
    `Routing kind mode must be fixture or selected-text: ${routingKindMode}`,
  );
}
const question = requiredQuestion(selectedRequestId);
if (existsSync(runPath)) throw new Error(`Run path already exists: ${runPath}`);
mkdirSync(runPath, { recursive: true });

const specs: RawHttpNodeSpec[] = experimentNodes.map((node, index) => ({
  id: node.id,
  port: 41_001 + index,
  peerIds: experimentPeersFor(node.id),
}));
const nodeById = new Map(experimentNodes.map((node) => [node.id, node]));
const threadByNode = new Map<string, string>();
const nodeByThread = new Map<string, string>();
const activeContextByThread = new Map<string, RawHttpRequestContext>();
const queues = new Map(
  experimentNodes.map((node) => [node.id, new SerialQueue()]),
);
const turnMetrics: TurnMetric[] = [];
const toolMetrics: ToolMetric[] = [];
const usedOutboundCalls = new Set<string>();
let blockedRepeatPeerCalls = 0;
let blockedHiddenPeerCalls = 0;
let network: RawHttpNetwork | null = null;
let answerBody: string | null = null;
let rootRequestId: string | null = null;
let rootStatus: number | null = null;
let startedAt: Date | null = null;
let endedAt: Date | null = null;
let failure: string | null = null;

const client = new AppServerClient({
  codexPath: findCodex(),
  stdoutLogPath: join(runPath, "app-server.jsonl"),
  stderrLogPath: join(runPath, "app-server.stderr.log"),
  turnTimeoutMs: 300_000,
  serverRequestHandler: async (request) => await handleServerRequest(request),
});

try {
  network = new RawHttpNetwork(
    specs,
    async (node, rawQuestion, context) =>
      await requiredQueue(node.id).run(async () => {
        const threadId = requiredThreadId(node.id);
        activeContextByThread.set(threadId, context);
        const turnStartedAt = new Date();
        let outcome: AppServerTurnOutcome;
        try {
          outcome = await client.runTurn(threadId, rawQuestion, {
            model,
            effort: reasoningEffort,
            serviceTier,
          });
        } finally {
          activeContextByThread.delete(threadId);
        }
        const unexpected = outcome.completedItemTypes.filter(
          (type) => !ALLOWED_ITEM_TYPES.has(type),
        );
        if (unexpected.length > 0) {
          throw new Error(
            `Node ${node.id} emitted unsupported items: ${unexpected.join(", ")}`,
          );
        }
        turnMetrics.push({
          nodeId: node.id,
          threadId,
          turnId: outcome.turnId,
          requestId: context.requestId,
          input: rawQuestion,
          output: outcome.finalText,
          startedAt: turnStartedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: outcome.durationMs,
          completedItemTypes: outcome.completedItemTypes,
        });
        return outcome.finalText;
      }),
    { peerTimeoutMs: 300_000 },
  );

  await client.initialize();
  await Promise.all(
    experimentNodes.map(async (node) => {
      const result = expectObject(
        await client.request("thread/start", threadParams(node.id)),
        `thread/start ${node.id}`,
      );
      const thread = expectObject(result["thread"], `${node.id}.thread`);
      const threadId = expectString(thread["id"], `${node.id}.thread.id`);
      threadByNode.set(node.id, threadId);
      nodeByThread.set(threadId, node.id);
    }),
  );
  assert(
    threadByNode.size === experimentNodes.length,
    "not every node received a thread",
  );
  const loaded = expectObject(
    await client.request("thread/loaded/list", {}),
    "thread/loaded/list",
  )["data"];
  assert(Array.isArray(loaded), "thread/loaded/list.data must be an array");
  const loadedIds = new Set(
    loaded.filter((value): value is string => typeof value === "string"),
  );
  assert(
    [...threadByNode.values()].every((threadId) => loadedIds.has(threadId)),
    "not every raw HTTP node thread is loaded",
  );

  writeManifest();
  startedAt = new Date();
  const rootAnswer = await network.ask(question.origin, question.question);
  endedAt = new Date();
  answerBody = rootAnswer.body;
  rootRequestId = rootAnswer.requestId;
  rootStatus = rootAnswer.status;
  if (!rootAnswer.ok) {
    throw new Error(`Root HTTP request failed (${rootAnswer.status}): ${rootAnswer.body}`);
  }
} catch (error: unknown) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (network !== null) {
    writeTrace(network.trace());
    await network.close();
  }
  await client.close();
}

const trace = readTrace();
const rootEvents =
  rootRequestId === null
    ? []
    : trace.filter((event) => event["requestId"] === rootRequestId);
const route = rootEvents
  .filter((event) => event["kind"] === "request_started")
  .map((event) => expectString(event["nodeId"], "trace.nodeId"));
const forwardedQuestions = rootEvents
  .filter((event) => event["kind"] === "peer_call_started")
  .map((event) => expectString(event["question"], "trace.question"));
const answerContainsExpected =
  answerBody?.toLocaleLowerCase().includes(question.answer.toLocaleLowerCase()) ??
  false;
const answerMatchesExpected =
  answerBody !== null && matchesExpectedAnswer(answerBody, question.answer);
const inferredRoutingKindsByNode = Object.fromEntries(
  experimentNodes.map((node) => [
    node.id,
    inferredRoutingKindFor(node.id) ?? null,
  ]),
);
const usedRoutingKindsByNode = Object.fromEntries(
  experimentNodes.map((node) => [node.id, usedRoutingKindFor(node.id) ?? null]),
);
const summary = {
  ok: failure === null && rootStatus === 200 && answerMatchesExpected,
  failure,
  runPath,
  model,
  reasoningEffort,
  serviceTierRequested: serviceTier,
  virtualAgents: experimentNodes.length,
  listeners: specs.length,
  loadedThreads: threadByNode.size,
  question: question.question,
  requestId: question.requestId,
  origin: question.origin,
  holder: question.holder,
  routingKind: question.routingKind ?? null,
  corpusMode,
  graphPreset,
  routingMemoryPath,
  onePeerPerNodeRequest,
  hardKnownRoutes,
  peerTopicAdvertisements,
  directoryRouting,
  profilePresentation,
  memoryProse,
  routingKindMode,
  routingKindSource:
    routingKindMode === "fixture"
      ? "question fixture metadata"
      : "selected request text, precomputed before the HTTP request",
  inferredRoutingKindsByNode,
  usedRoutingKindsByNode,
  expectedAnswer: question.answer,
  answer: answerBody,
  answerContainsExpected,
  answerMatchesExpected,
  rootStatus,
  rootRequestId,
  startedAt: startedAt?.toISOString() ?? null,
  endedAt: endedAt?.toISOString() ?? null,
  durationMs:
    startedAt === null || endedAt === null
      ? null
      : endedAt.getTime() - startedAt.getTime(),
  route,
  modelTurns: turnMetrics.length,
  peerCalls: toolMetrics.length,
  blockedRepeatPeerCalls,
  blockedHiddenPeerCalls,
  forwardedQuestions,
  rawQuestionPreservedAcrossHops: forwardedQuestions.every(
    (forwarded) => forwarded === question.question,
  ),
  rejectedCycles: rootEvents.filter(
    (event) => event["kind"] === "request_rejected",
  ).length,
  promptCharacters: prompt.length,
  promptWords: prompt.length === 0 ? 0 : prompt.split(/\s+/u).length,
  cache: false,
  transitionEnvelope: false,
  callerIds: false,
  pendingState: false,
  turns: turnMetrics,
  tools: toolMetrics,
};
writeFileSync(
  join(runPath, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (!summary.ok) process.exitCode = 1;

async function handleServerRequest(request: AppServerRequest): Promise<JsonValue> {
  if (request.method !== "item/tool/call") {
    throw new Error(`Unsupported app-server request: ${request.method}`);
  }
  const params = expectObject(request.params, "item/tool/call params");
  const threadId = expectString(params["threadId"], "tool.threadId");
  const turnId = expectString(params["turnId"], "tool.turnId");
  const callId = expectString(params["callId"], "tool.callId");
  const tool = expectString(params["tool"], "tool.tool");
  assert(tool === "ask_peer", `Unsupported dynamic tool: ${tool}`);
  assert(params["namespace"] === null, "ask_peer must not have a namespace");
  const argumentsObject = expectObject(params["arguments"], "tool.arguments");
  const address = expectString(argumentsObject["address"], "tool.address");
  const rawQuestion = expectString(argumentsObject["question"], "tool.question");
  const nodeId = nodeByThread.get(threadId);
  if (nodeId === undefined) throw new Error(`Unknown tool-calling thread ${threadId}`);
  const context = activeContextByThread.get(threadId);
  if (context === undefined) {
    throw new Error(`No active HTTP request for tool-calling node ${nodeId}`);
  }
  if (network === null) throw new Error("HTTP network is not running");
  const callStartedAt = new Date();
  const visibleAddresses = new Set(
    network
      .peerUrlsFor(nodeId)
      .filter((peer) => visiblePeerIdsFor(nodeId).includes(peer.id))
      .map((peer) => peer.address),
  );
  if (!visibleAddresses.has(address)) {
    blockedHiddenPeerCalls += 1;
    const answer = "Peer address is not listed for this question.";
    toolMetrics.push({
      nodeId,
      threadId,
      turnId,
      callId,
      requestId: context.requestId,
      address,
      question: rawQuestion,
      answer,
      success: false,
      status: 403,
      startedAt: callStartedAt.toISOString(),
      endedAt: new Date().toISOString(),
    });
    return {
      contentItems: [{ type: "inputText", text: answer }],
      success: false,
    };
  }
  const outboundKey = `${context.requestId}:${nodeId}`;
  if (onePeerPerNodeRequest && usedOutboundCalls.has(outboundKey)) {
    blockedRepeatPeerCalls += 1;
    return {
      contentItems: [
        {
          type: "inputText",
          text: "This node already chose its one peer for this request.",
        },
      ],
      success: false,
    };
  }
  usedOutboundCalls.add(outboundKey);
  const reply = await network.forward(nodeId, address, rawQuestion, context);
  toolMetrics.push({
    nodeId,
    threadId,
    turnId,
    callId,
    requestId: context.requestId,
    address,
    question: rawQuestion,
    answer: reply.body,
    success: reply.ok,
    status: reply.status,
    startedAt: callStartedAt.toISOString(),
    endedAt: new Date().toISOString(),
  });
  return {
    contentItems: [
      {
        type: "inputText",
        text: reply.ok ? reply.body : `Peer could not answer: ${reply.body}`,
      },
    ],
    success: reply.ok,
  };
}

function threadParams(nodeId: string): JsonValue {
  if (network === null) throw new Error("HTTP network is not running");
  const node = nodeById.get(nodeId);
  if (node === undefined) throw new Error(`Unknown node ${nodeId}`);
  const privateFacts = privateFactsFor(nodeId);
  const fact =
    privateFacts.length === 0
      ? "No private facts."
      : privateFacts
          .map((item) => `${item.question}\nAnswer: ${item.answer}`)
          .join("\n\n");
  const memories = routingMemoryFor(nodeId);
  for (const entry of memories) {
    assert(
      experimentPeersFor(nodeId).includes(entry.peerId),
      `${nodeId} routing memory names non-peer ${entry.peerId}`,
    );
  }
  const peerUrls = new Map(
    network.peerUrlsFor(nodeId).map((peer) => [peer.id, peer] as const),
  );
  const visiblePeers = visiblePeerIdsFor(nodeId).map((peerId) => {
    const peer = peerUrls.get(peerId);
    assert(peer !== undefined, `Missing URL for direct peer ${peerId}`);
    return peer;
  });
  const peers = visiblePeers
    .map((peer) => {
      const currentExperience = peerSelectionFor(nodeId).latestByPeer.get(
        peer.id,
      );
      const experiences =
        currentExperience === undefined
          ? []
          : [currentExperience].map((entry) => {
              const outcome =
                entry.outcome === "tried_without_answer"
                  ? "did not lead to an answer"
                  : entry.outcome === "exploring"
                    ? "is still being explored"
                    : "led to an answer";
              const subject =
                entry.routingKind === undefined
                  ? `“${entry.question ?? "this question"}”`
                  : `questions about “${entry.routingKind}”`;
              return `${outcome} for ${subject}`;
          });
      const experience =
        memoryProse === "hide" || experiences.length === 0
          ? ""
          : ` — Previous experience: ${experiences.join("; ")}`;
      const advertisedTopics = peerTopicAdvertisements
        ? peerTopicsAdvertisedTo(peer.id, nodeId)
        : [];
      const advertisement =
        advertisedTopics.length === 0
          ? ""
          : ` — Also knows peers about: ${advertisedTopics.join("; ")}`;
      const visibleProfile = visibleProfileFor(peer.id);
      const profileText =
        visibleProfile.length === 0 ? "" : ` — ${visibleProfile}`;
      return `- ${peer.address}${profileText}${advertisement}${experience}`;
    })
    .join("\n");
  const privateTopic = visibleProfileFor(node.id);
  const sections = [
    prompt,
    privateTopic.length === 0 ? "" : `Private topic: ${privateTopic}`,
    `Private facts:\n${fact}`,
    `Listed peers:\n${peers}`,
  ].filter((section) => section.length > 0);
  return {
    model,
    serviceTier,
    cwd: "/private/tmp",
    approvalPolicy: "never",
    sandbox: "read-only",
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
        shell_tool: false,
        unified_exec: false,
      },
      mcp_servers: {
        node_repl: { enabled: false },
        openaiDeveloperDocs: { enabled: false },
      },
    },
    baseInstructions: sections.join("\n\n"),
    ephemeral: true,
    environments: [],
    dynamicTools: [
      {
        type: "function",
        name: "ask_peer",
        description:
          "Ask one listed peer a question through its HTTP address and wait for its raw text answer.",
        inputSchema: {
          type: "object",
          properties: {
            address: {
              type: "string",
              description: "One exact HTTP address from Listed peers.",
            },
            question: { type: "string", description: "The question to ask." },
          },
          required: ["address", "question"],
          additionalProperties: false,
        },
      },
    ],
  };
}

function writeManifest(): void {
  if (network === null) throw new Error("HTTP network is not running");
  const manifest = {
    id: `04-raw-http-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    prompt,
    promptPath,
    execution,
    graphPreset,
    routingMemoryPath,
    onePeerPerNodeRequest,
    hardKnownRoutes,
    peerTopicAdvertisements,
    directoryRouting,
    profilePresentation,
    memoryProse,
    routingKindMode,
    routingKindSource:
      routingKindMode === "fixture"
        ? "question fixture metadata"
        : "selected request text, precomputed before the HTTP request",
    nodes: experimentNodes.map((node) => ({
      id: node.id,
      address: network?.urlFor(node.id),
      threadId: requiredThreadId(node.id),
      profile: node.profile,
      visibleProfile: visibleProfileFor(node.id),
      peers: network?.peerUrlsFor(node.id).map((peer) => ({
        ...peer,
        profile: experimentProfileFor(peer.id),
        visibleProfile: visibleProfileFor(peer.id),
      })),
      routingMemory: routingMemoryFor(node.id),
      inferredRoutingKind: inferredRoutingKindFor(node.id) ?? null,
      usedRoutingKind: usedRoutingKindFor(node.id) ?? null,
      visiblePeerIds: visiblePeerIdsFor(node.id),
      hiddenPeerIds: peerSelectionFor(node.id).hiddenPeerIds,
      sidelinedPeerIds: peerSelectionFor(node.id).sidelinedPeerIds,
      directorySelection: directorySelectionFor(node.id),
      privateFacts: privateFactsFor(node.id).map((item) => ({
        requestId: item.requestId,
        question: item.question,
        answer: item.answer,
      })),
    })),
  };
  writeFileSync(
    join(runPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function writeTrace(events: readonly unknown[]): void {
  writeFileSync(
    join(runPath, "trace.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
}

function readTrace(): Array<{ [key: string]: JsonValue }> {
  const path = join(runPath, "trace.jsonl");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) return [];
  return text.split("\n").map((line, index) =>
    expectObject(JSON.parse(line) as JsonValue, `trace line ${index + 1}`),
  );
}

function requiredThreadId(nodeId: string): string {
  const threadId = threadByNode.get(nodeId);
  if (threadId === undefined) throw new Error(`No thread for ${nodeId}`);
  return threadId;
}

function requiredQueue(nodeId: string): SerialQueue {
  const queue = queues.get(nodeId);
  if (queue === undefined) throw new Error(`No queue for ${nodeId}`);
  return queue;
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

function expectString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  if (found === undefined) {
    throw new Error("Codex CLI not found; set CODEX_CLI to its absolute path");
  }
  return found;
}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

interface TurnMetric {
  nodeId: string;
  threadId: string;
  turnId: string;
  requestId: string;
  input: string;
  output: string;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  completedItemTypes: string[];
}

interface ToolMetric {
  nodeId: string;
  threadId: string;
  turnId: string;
  callId: string;
  requestId: string;
  address: string;
  question: string;
  answer: string;
  success: boolean;
  status: number;
  startedAt: string;
  endedAt: string;
}

interface ExperimentQuestion {
  requestId: string;
  origin: string;
  holder: string;
  question: string;
  answer: string;
  routingKind?: string;
  idealRoute: readonly [string, string, string];
}

interface RoutingMemoryEntry {
  question?: string;
  kind?: string;
  peerId: string;
  outcome: "answered" | "exploring" | "tried_without_answer";
}

function privateFactsFor(nodeId: string): ExperimentQuestion[] {
  return experimentQuestions.filter(
    (candidate) =>
      candidate.holder === nodeId &&
      (corpusMode === "all" || candidate.requestId === question.requestId),
  );
}

function requiredQuestion(requestId: string): ExperimentQuestion {
  const match = experimentQuestions.find(
    (candidate) => candidate.requestId === requestId,
  );
  if (match === undefined) throw new Error(`Unknown request: ${requestId}`);
  return match;
}

function experimentPeersFor(nodeId: string): string[] {
  return scaledGraph === null
    ? legacyPeersFor(nodeId)
    : scaledPeersFor(scaledGraph, nodeId);
}

function experimentProfileFor(nodeId: string): string {
  const profile = profileByNode.get(nodeId);
  if (profile === undefined) throw new Error(`Unknown node: ${nodeId}`);
  return profile;
}

function visibleProfileFor(nodeId: string): string {
  if (profilePresentation === "none") return "";
  if (profilePresentation === "topic") return experimentTopicFor(nodeId);
  if (profilePresentation === "topic-role") {
    const role = experimentProfileFor(nodeId).split(";").at(-1)?.trim() ?? "";
    return [experimentTopicFor(nodeId), role].filter(Boolean).join("; ");
  }
  return experimentProfileFor(nodeId);
}

function peerTopicsAdvertisedTo(peerId: string, callerId: string): string[] {
  return [
    ...new Set(
      experimentPeersFor(peerId)
        .filter((candidate) => candidate !== callerId)
        .map((candidate) => experimentTopicFor(candidate)),
    ),
  ];
}

function experimentTopicFor(nodeId: string): string {
  return experimentProfileFor(nodeId).split(" — ")[0]?.trim() ?? "";
}

function routingMemoryFor(nodeId: string): RoutingMemoryEntry[] {
  return routingMemory.get(nodeId) ?? [];
}

function visiblePeerIdsFor(nodeId: string): string[] {
  const memoryPeers = peerSelectionFor(nodeId).visiblePeerIds;
  if (!directoryRouting) return memoryPeers;
  const directoryPeers = new Set(directorySelectionFor(nodeId).peerIds);
  return memoryPeers.filter((peerId) => directoryPeers.has(peerId));
}

function directorySelectionFor(nodeId: string) {
  const directPeerIds = experimentPeersFor(nodeId);
  const directoryPeers = directPeerIds.map((peerId) => ({
    id: peerId,
    ownTopic: experimentTopicFor(peerId),
    advertisedTopics: peerTopicsAdvertisedTo(peerId, nodeId),
  }));
  const knownTopics = [
    ...new Set(
      directoryPeers.flatMap((peer) => [peer.ownTopic, ...peer.advertisedTopics]),
    ),
  ].filter((topic) => topic.length > 0);
  return selectDirectoryPeers(
    question.question,
    knownTopics,
    directoryPeers,
  );
}

function peerSelectionFor(nodeId: string) {
  const entries = policyMemoryEntriesFor(nodeId);
  const routingKind = usedRoutingKindFor(nodeId);
  return selectPeers(experimentPeersFor(nodeId), entries, {
    question: question.question,
    ...(routingKind === undefined ? {} : { routingKind }),
    hardKnownRoutes,
  });
}

function policyMemoryEntriesFor(nodeId: string): PolicyMemoryEntry[] {
  return routingMemoryFor(nodeId).map((entry) => ({
    peerId: entry.peerId,
    ...(entry.question === undefined ? {} : { question: entry.question }),
    ...(entry.kind === undefined ? {} : { routingKind: entry.kind }),
    outcome: entry.outcome,
  }));
}

function inferredRoutingKindFor(nodeId: string): string | undefined {
  return inferRoutingKind(question.question, policyMemoryEntriesFor(nodeId));
}

function usedRoutingKindFor(nodeId: string): string | undefined {
  return routingKindMode === "fixture"
    ? question.routingKind
    : inferredRoutingKindFor(nodeId);
}

function readRoutingMemory(path: string | null): Map<string, RoutingMemoryEntry[]> {
  if (path === null) return new Map();
  const parsed = expectObject(
    JSON.parse(readFileSync(path, "utf8")) as JsonValue,
    "routing memory",
  );
  const result = new Map<string, RoutingMemoryEntry[]>();
  for (const [nodeId, value] of Object.entries(parsed)) {
    assert(Array.isArray(value), `routing memory for ${nodeId} must be an array`);
    result.set(
      nodeId,
      value.map((item, index) => {
        const entry = expectObject(item, `routing memory ${nodeId}[${index}]`);
        const entryQuestion = expectOptionalString(
          entry["question"],
          "routing memory question",
        );
        const kind = expectOptionalString(entry["kind"], "routing memory kind");
        assert(
          entryQuestion !== undefined || kind !== undefined,
          "routing memory entry needs question or kind",
        );
        return {
          ...(entryQuestion === undefined ? {} : { question: entryQuestion }),
          ...(kind === undefined ? {} : { kind }),
          peerId: expectString(entry["peerId"], "routing memory peerId"),
          outcome: expectRoutingOutcome(entry["outcome"]),
        };
      }),
    );
  }
  return result;
}

function expectOptionalString(
  value: JsonValue | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, label);
}

function expectRoutingOutcome(
  value: JsonValue | undefined,
): "answered" | "exploring" | "tried_without_answer" {
  if (value === undefined) return "answered";
  if (value === "not_found") return "tried_without_answer";
  assert(
    value === "answered" ||
      value === "exploring" ||
      value === "tried_without_answer",
    "routing memory outcome must be answered, exploring, or tried_without_answer",
  );
  return value;
}
