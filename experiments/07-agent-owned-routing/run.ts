import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
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
  generateScaleMemoryGraph,
  peersFor,
} from "../05-scale-memory/graph.ts";
import { matchesExpectedAnswer } from "../04-raw-http/answer-match.ts";

const runPath = resolve(requiredArg(2, "run path"));
const requestIds = requiredArg(3, "comma-separated request ids").split(",");
const sourcePath =
  process.argv[4] === undefined || process.argv[4] === "clean"
    ? null
    : resolve(process.argv[4]);
const model = process.argv[5] ?? "gpt-5.6-luna";
const promptPath = resolve(
  process.argv[6] ?? "experiments/07-agent-owned-routing/prompt.md",
);
const peerInfo = process.argv[7] ?? "advertise";
assert(
  peerInfo === "advertise" || peerInfo === "plain",
  `peer info must be advertise or plain: ${peerInfo}`,
);
const prompt = readFileSync(promptPath, "utf8").trim();
const reasoningEffort = "low";
const serviceTier = "fast";
const graph = generateScaleMemoryGraph({ variantsPerRoute: 2 });
const questions = requestIds.map(requiredQuestion);
assert(new Set(requestIds).size === requestIds.length, "request ids must be unique");
assert(
  questions.every((question) => question.requestId.endsWith("-a")) ||
    questions.every((question) => question.requestId.endsWith("-b")),
  "run either A questions or B questions, not both",
);
if (existsSync(runPath)) throw new Error(`Run path already exists: ${runPath}`);
mkdirSync(runPath, { recursive: true });
const workspaceRoot = join(runPath, "nodes");
mkdirSync(workspaceRoot);
const promptSnapshotPath = join(runPath, "prompt.md");
writeFileSync(promptSnapshotPath, `${prompt}\n`, "utf8");
const logRoot = `/private/tmp/net-07-${randomUUID()}`;
mkdirSync(logRoot);

for (const node of graph.nodes) {
  const nodePath = nodeWorkspace(node.id);
  if (sourcePath === null) mkdirSync(nodePath);
  else cpSync(join(sourcePath, node.id), nodePath, { recursive: true });
  const knowledge = graph.corpusByNode.get(node.id);
  assert(knowledge !== undefined, `missing corpus for ${node.id}`);
  writeFileSync(
    join(nodePath, "knowledge.md"),
    `${knowledge.filter((record) =>
      questions.some(
        (question) => question.holder === node.id && record.includes(question.answer),
      )
    ).join("\n")}\n`,
  );
  writeFileSync(
    join(nodePath, "peers.md"),
    `${[...peersFor(graph, node.id)]
      .sort()
      .map((peerId) => {
        const address = `http://127.0.0.1:${portFor(peerId)}/ask`;
        if (peerInfo === "plain") {
          return `DIRECT ${peerId} | address: ${address}`;
        }
        const advertised = peersFor(graph, peerId)
          .filter((candidate) => candidate !== node.id)
          .sort()
          .join(", ");
        return `DIRECT ${peerId} | address: ${address} | that peer can reach (not directly callable here): ${advertised}`;
      })
      .join("\n")}\n`,
  );
  const memoryPath = join(nodePath, "routing.md");
  if (!existsSync(memoryPath)) writeFileSync(memoryPath, "", "utf8");
}
const initialRoutingByNode = new Map(
  graph.nodes.map((node) => [
    node.id,
    readFileSync(join(nodeWorkspace(node.id), "routing.md"), "utf8"),
  ]),
);

const specs: RawHttpNodeSpec[] = graph.nodes.map((node) => ({
  id: node.id,
  port: portFor(node.id),
  peerIds: peersFor(graph, node.id),
}));
const activeContextByThread = new Map<string, RawHttpRequestContext>();
const nodeByThread = new Map<string, string>();
const queues = new Map(graph.nodes.map((node) => [node.id, new SerialQueue()]));
const turns: TurnMetric[] = [];
const tools: ToolMetric[] = [];
let network: RawHttpNetwork | null = null;
let failure: string | null = null;
let traceSnapshot: ReturnType<RawHttpNetwork["trace"]> = [];
let turnSnapshot: TurnMetric[] = [];
let toolSnapshot: ToolMetric[] = [];
const client = new AppServerClient({
  codexPath: findCodex(),
  stdoutLogPath: join(logRoot, "app-server.jsonl"),
  stderrLogPath: join(logRoot, "app-server.stderr.log"),
  turnTimeoutMs: 300_000,
  enableShellTools: true,
  serverRequestHandler: async (request) => await handleServerRequest(request),
});
const results: QuestionResult[] = [];

try {
  network = new RawHttpNetwork(
    specs,
    async (node, rawQuestion, context) =>
      await requiredQueue(node.id).run(
        async () => await answerAtNode(node.id, rawQuestion, context),
      ),
    { peerTimeoutMs: 300_000 },
  );
  await client.initialize();
  writeManifest();
  for (const question of questions) {
    const traceStart = network.trace().length;
    const startedAt = Date.now();
    const answer = await network.ask(question.origin, question.question);
    const trace = network.trace().slice(traceStart);
    const requestEvents = trace.filter(
      (event) => event.requestId === answer.requestId,
    );
    const forwardedQuestions = requestEvents
      .filter((event) => event.kind === "peer_call_started")
      .map((event) => event.question);
    results.push({
      requestId: question.requestId,
      question: question.question,
      origin: question.origin,
      holder: question.holder,
      expectedAnswer: question.answer,
      answer: answer.body,
      ok: answer.ok && matchesExpectedAnswer(answer.body, question.answer),
      status: answer.status,
      durationMs: Date.now() - startedAt,
      peerCalls: requestEvents.filter(
        (event) => event.kind === "peer_call_started",
      ).length,
      route: requestEvents
        .filter((event) => event.kind === "request_started")
        .map((event) => event.nodeId),
      cycles: requestEvents.filter(
        (event) => event.kind === "request_rejected",
      ).length,
      rawQuestionPreserved: forwardedQuestions.every(
        (forwarded) => forwarded === question.question,
      ),
    });
  }
} catch (error: unknown) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (network !== null) {
    traceSnapshot = network.trace();
    turnSnapshot = [...turns];
    toolSnapshot = [...tools];
    writeFileSync(
      join(runPath, "trace.jsonl"),
      `${traceSnapshot
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    await network.close();
  }
  await client.close();
  cpSync(join(logRoot, "app-server.jsonl"), join(runPath, "app-server.jsonl"));
  const stderrPath = join(logRoot, "app-server.stderr.log");
  if (existsSync(stderrPath)) {
    cpSync(stderrPath, join(runPath, "app-server.stderr.log"));
  }
}

const memoryFiles = graph.nodes.map((node) => {
  const path = join(nodeWorkspace(node.id), "routing.md");
  return { nodeId: node.id, text: readFileSync(path, "utf8") };
});
const summary = {
  ok: failure === null && results.length === questions.length &&
    results.every((result) => result.ok),
  failure,
  runPath,
  model,
  reasoningEffort,
  serviceTierRequested: serviceTier,
  requestIds,
  sourcePath,
  peerInfo,
  virtualAgents: graph.nodes.length,
  prompt,
  promptWords: prompt.split(/\s+/u).length,
  routingAuthority: "agent filesystem and reasoning",
  harnessPeerSelection: false,
  results,
  totalPeerCalls: traceSnapshot.filter(
    (event) => event.kind === "peer_call_started",
  ).length,
  files: fileInventory(workspaceRoot),
  routingFilesChanged: memoryFiles.filter(
    (file) => file.text !== initialRoutingByNode.get(file.nodeId),
  ).length,
  routingFiles: memoryFiles.filter((file) => file.text.length > 0),
  turns: turnSnapshot,
  tools: toolSnapshot,
};
writeFileSync(join(runPath, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (!summary.ok) process.exitCode = 1;

async function answerAtNode(
  nodeId: string,
  rawQuestion: string,
  context: RawHttpRequestContext,
): Promise<string> {
  const workspace = nodeWorkspace(nodeId);
  const threadId = await startThread(nodeId);
  const turnStartedAt = new Date();
  activeContextByThread.set(threadId, context);
  let outcome: AppServerTurnOutcome;
  try {
    outcome = await client.runTurn(threadId, rawQuestion, {
      model,
      effort: reasoningEffort,
      serviceTier,
      writableRoot: workspace,
    });
  } finally {
    activeContextByThread.delete(threadId);
    nodeByThread.delete(threadId);
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
    throw new Error(`${nodeId} emitted unsupported items: ${unexpected.join(", ")}`);
  }
  turns.push({
    nodeId,
    threadId,
    turnId: outcome.turnId,
    requestId: context.requestId,
    input: rawQuestion,
    output: outcome.finalText,
    startedAt: turnStartedAt.toISOString(),
    endedAt: new Date().toISOString(),
    completedItemTypes: outcome.completedItemTypes,
  });
  return outcome.finalText;
}

async function startThread(nodeId: string): Promise<string> {
  const workspace = nodeWorkspace(nodeId);
  const result = expectObject(
    await client.request("thread/start", {
      model,
      serviceTier,
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
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
          description:
            "Ask a direct peer from peers.md and wait for its raw answer.",
          inputSchema: {
            type: "object",
            properties: {
              address: {
                type: "string",
                description: "The exact http:// address after `address:` on a DIRECT line in peers.md.",
              },
              question: {
                type: "string",
                description: "The incoming question, unchanged.",
              },
            },
            required: ["address", "question"],
            additionalProperties: false,
          },
        },
      ],
    }),
    `thread/start ${nodeId}`,
  );
  const thread = expectObject(result["thread"], `${nodeId}.thread`);
  const threadId = expectString(thread["id"], `${nodeId}.thread.id`);
  nodeByThread.set(threadId, nodeId);
  return threadId;
}

async function handleServerRequest(request: AppServerRequest): Promise<JsonValue> {
  assert(request.method === "item/tool/call", `unsupported request ${request.method}`);
  const params = expectObject(request.params, "item/tool/call params");
  const threadId = expectString(params["threadId"], "tool.threadId");
  const turnId = expectString(params["turnId"], "tool.turnId");
  const callId = expectString(params["callId"], "tool.callId");
  assert(params["tool"] === "ask_peer", "unsupported dynamic tool");
  const args = expectObject(params["arguments"], "tool.arguments");
  const address = expectString(args["address"], "tool.address");
  const rawQuestion = expectString(args["question"], "tool.question");
  const nodeId = nodeByThread.get(threadId);
  assert(nodeId !== undefined, `unknown thread ${threadId}`);
  const context = activeContextByThread.get(threadId);
  assert(context !== undefined, `no active request for ${nodeId}`);
  assert(network !== null, "network is not running");
  const listed = network.peerUrlsFor(nodeId).some((peer) => peer.address === address);
  const startedAt = new Date();
  if (!listed) {
    const answer = "That address is not a direct peer in peers.md.";
    tools.push({
      nodeId,
      requestId: context.requestId,
      turnId,
      callId,
      address,
      question: rawQuestion,
      answer,
      success: false,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
    });
    return { contentItems: [{ type: "inputText", text: answer }], success: false };
  }
  const reply = await network.forward(nodeId, address, rawQuestion, context);
  tools.push({
    nodeId,
    requestId: context.requestId,
    turnId,
    callId,
    address,
    question: rawQuestion,
    answer: reply.body,
    success: reply.ok,
    startedAt: startedAt.toISOString(),
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

function writeManifest(): void {
  assert(network !== null, "network is not running");
  writeFileSync(
    join(runPath, "manifest.json"),
    `${JSON.stringify(
      {
        id: `07-agent-owned-${randomUUID()}`,
        createdAt: new Date().toISOString(),
        model,
        promptPath,
        prompt,
        requestIds,
        sourcePath,
        peerInfo,
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          workspace: nodeWorkspace(node.id),
          address: network?.urlFor(node.id),
          peers: network?.peerUrlsFor(node.id),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

function requiredQuestion(requestId: string) {
  const question = graph.questions.find((candidate) => candidate.requestId === requestId);
  assert(question !== undefined, `unknown request ${requestId}`);
  return question;
}

function portFor(nodeId: string): number {
  const index = graph.nodes.findIndex((node) => node.id === nodeId);
  assert(index >= 0, `unknown node ${nodeId}`);
  return 42_001 + index;
}

function nodeWorkspace(nodeId: string): string {
  return join(workspaceRoot, nodeId);
}

function requiredQueue(nodeId: string): SerialQueue {
  const queue = queues.get(nodeId);
  assert(queue !== undefined, `missing queue for ${nodeId}`);
  return queue;
}

function fileInventory(root: string): Array<{ path: string; bytes: number }> {
  const files: Array<{ path: string; bytes: number }> = [];
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stat = statSync(child);
      if (stat.isDirectory()) visit(child);
      else files.push({ path: child.slice(root.length + 1), bytes: stat.size });
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
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
    (candidate): candidate is string => candidate !== undefined && existsSync(candidate),
  );
  if (found === undefined) throw new Error("Codex CLI not found");
  return found;
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
  completedItemTypes: string[];
}

interface ToolMetric {
  nodeId: string;
  requestId: string;
  turnId: string;
  callId: string;
  address: string;
  question: string;
  answer: string;
  success: boolean;
  startedAt: string;
  endedAt: string;
}

interface QuestionResult {
  requestId: string;
  question: string;
  origin: string;
  holder: string;
  expectedAnswer: string;
  answer: string;
  ok: boolean;
  status: number;
  durationMs: number;
  peerCalls: number;
  route: string[];
  cycles: number;
  rawQuestionPreserved: boolean;
}
