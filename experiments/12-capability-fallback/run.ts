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

type PeerId = "node-42" | "node-68" | "node-93" | "node-17";
type CaseKind = "peer-only" | "archive-only" | "nobody";

type Fixture = {
  id: string;
  kind: CaseKind;
  question: string;
  answer: string;
  peerReplies: Record<PeerId, string>;
  archiveReply: string;
  answerPeer?: PeerId;
  answerInArchive: boolean;
  decoys: string[];
};

type SourceCall = {
  tool: "ask_peer" | "search_archive";
  endpoint: string;
  peer?: PeerId;
  input: string;
  reply: string;
  useful: boolean;
  startSequence: number;
  finishSequence: number;
};

type ActiveCase = {
  fixture: Fixture;
  calls: SourceCall[];
  violations: string[];
};

type CaseResult = {
  id: string;
  kind: CaseKind;
  threadId: string;
  output: string;
  answerCorrect: boolean;
  explicitlyUnresolved: boolean;
  calledUsefulSource: boolean;
  calledEverySource: boolean;
  noRepeatedEndpoint: boolean;
  noCallAfterUsefulReply: boolean;
  peerQuestionsPreserved: boolean;
  outputContainsDecoy: boolean;
  routingContainsFixtureToken: boolean;
  firstTool: SourceCall["tool"] | null;
  toolSequence: string[];
  calls: SourceCall[];
  routingBefore: string;
  routingAfter: string;
  violations: string[];
  pass: boolean;
  durationMs: number;
};

const runPath = resolve(requiredArg(2, "run path"));
const model = process.argv[3] ?? "gpt-5.6-luna";
const promptPath = resolve(
  process.argv[4] ?? "experiments/08-isolated-learning/prompt.md",
);
const prompt = readFileSync(promptPath, "utf8").trim();
const baselinePrompt = readFileSync(
  resolve("experiments/08-isolated-learning/prompt.md"),
  "utf8",
).trim();
const reasoningEffort = "low";
const serviceTier = "fast";
const peerIds: PeerId[] = ["node-42", "node-68", "node-93", "node-17"];
const fixtures = makeFixtures();

assertRawProseFixtures();
if (existsSync(runPath)) throw new Error(`Run path already exists: ${runPath}`);
mkdirSync(runPath, { recursive: true });
writeFileSync(join(runPath, "prompt.md"), `${prompt}\n`, "utf8");

const activeByThread = new Map<string, ActiveCase>();
const globalViolations: string[] = [];
let eventSequence = 0;
const client = new AppServerClient({
  codexPath: findCodex(),
  stdoutLogPath: join(runPath, "app-server.jsonl"),
  stderrLogPath: join(runPath, "app-server.stderr.log"),
  turnTimeoutMs: 180_000,
  enableShellTools: true,
  serverRequestHandler: async (request) => await handleToolCall(request),
});

let failure: string | null = null;
let results: CaseResult[] = [];
try {
  await client.initialize();
  results = await Promise.all(fixtures.map(async (fixture) => await runCase(fixture)));
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

async function runCase(fixture: Fixture): Promise<CaseResult> {
  const world = makeWorld(fixture.id);
  const routingPath = join(world, "routing.md");
  const routingBefore = readFileSync(routingPath, "utf8");
  const threadId = await startThread(world);
  const active: ActiveCase = { fixture, calls: [], violations: [] };
  activeByThread.set(threadId, active);
  const startedAt = Date.now();
  let outcome: AppServerTurnOutcome;
  try {
    outcome = await client.runTurn(threadId, fixture.question, {
      model,
      effort: reasoningEffort,
      serviceTier,
      writableRoot: world,
    });
  } finally {
    activeByThread.delete(threadId);
  }
  const routingAfter = readFileSync(routingPath, "utf8");
  const answerCorrect = matchesExpectedAnswer(outcome.finalText, fixture.answer);
  const explicitlyUnresolved = isExplicitlyUnresolved(outcome.finalText);
  const calledUsefulSource = active.calls.some((call) => call.useful);
  const endpoints = active.calls.map((call) => call.endpoint);
  const expectedEndpoints = [...peerIds.map((peer) => `peer:${peer}`), "archive"];
  const calledEverySource = expectedEndpoints.every((endpoint) =>
    endpoints.includes(endpoint)
  );
  const noRepeatedEndpoint = new Set(endpoints).size === endpoints.length;
  const firstUseful = active.calls.find((call) => call.useful);
  const noCallAfterUsefulReply = firstUseful === undefined || active.calls.every(
    (call) =>
      call.startSequence <= firstUseful.finishSequence || call === firstUseful,
  );
  const peerQuestionsPreserved = active.calls
    .filter((call) => call.tool === "ask_peer")
    .every((call) => call.input === fixture.question);
  const outputContainsDecoy = fixture.decoys.some((token) =>
    outcome.finalText.includes(token)
  );
  const fixtureTokens = [fixture.answer, ...fixture.decoys];
  const routingContainsFixtureToken = fixtureTokens.some((token) =>
    routingAfter.includes(token)
  );
  const commonPass =
    active.violations.length === 0 &&
    peerQuestionsPreserved &&
    !routingContainsFixtureToken;
  const pass = fixture.kind === "nobody"
    ? commonPass &&
      calledEverySource &&
      explicitlyUnresolved &&
      !answerCorrect
    : commonPass && calledUsefulSource && answerCorrect && !outputContainsDecoy;
  return {
    id: fixture.id,
    kind: fixture.kind,
    threadId,
    output: outcome.finalText,
    answerCorrect,
    explicitlyUnresolved,
    calledUsefulSource,
    calledEverySource,
    noRepeatedEndpoint,
    noCallAfterUsefulReply,
    peerQuestionsPreserved,
    outputContainsDecoy,
    routingContainsFixtureToken,
    firstTool: active.calls[0]?.tool ?? null,
    toolSequence: active.calls.map((call) => call.endpoint),
    calls: active.calls,
    routingBefore,
    routingAfter,
    violations: active.violations,
    pass,
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
        {
          type: "function",
          name: "search_archive",
          description: "Search this node's local archive and receive its raw notes.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    }),
    "thread/start",
  );
  return expectString(expectObject(value["thread"], "thread")["id"], "thread.id");
}

async function handleToolCall(request: AppServerRequest): Promise<JsonValue> {
  try {
    assert(request.method === "item/tool/call", `unsupported ${request.method}`);
    const params = expectObject(request.params, "tool params");
    const threadId = expectString(params["threadId"], "tool.threadId");
    const tool = expectString(params["tool"], "tool name");
    const args = expectObject(params["arguments"], "tool arguments");
    const active = activeByThread.get(threadId);
    assert(active !== undefined, `no active case for ${threadId}`);
    const startSequence = ++eventSequence;
    let call: Omit<SourceCall, "finishSequence">;
    if (tool === "ask_peer") {
      const peerText = expectString(args["peer"], "tool.peer");
      assert(isPeer(peerText), `unknown peer ${peerText}`);
      const question = expectString(args["question"], "tool.question");
      call = {
        tool,
        endpoint: `peer:${peerText}`,
        peer: peerText,
        input: question,
        reply: active.fixture.peerReplies[peerText],
        useful: active.fixture.answerPeer === peerText,
        startSequence,
      };
    } else if (tool === "search_archive") {
      const query = expectString(args["query"], "tool.query");
      call = {
        tool,
        endpoint: "archive",
        input: query,
        reply: active.fixture.archiveReply,
        useful: active.fixture.answerInArchive,
        startSequence,
      };
    } else {
      throw new Error(`unsupported tool ${tool}`);
    }
    const completed: SourceCall = {
      ...call,
      finishSequence: ++eventSequence,
    };
    active.calls.push(completed);
    return {
      contentItems: [{ type: "inputText", text: completed.reply }],
      success: true,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    globalViolations.push(message);
    throw error;
  }
}

function makeWorld(name: string): string {
  const world = join(runPath, "worlds", name);
  mkdirSync(world, { recursive: true });
  writeFileSync(join(world, "routing.md"), "# Routing notes\n", "utf8");
  writeFileSync(
    join(world, "peers.md"),
    `${peerIds.map((peer) => `- ${peer}`).join("\n")}\n`,
    "utf8",
  );
  return world;
}

function summarize() {
  const threadIds = results.map((result) => result.threadId);
  return {
    ok:
      failure === null &&
      globalViolations.length === 0 &&
      results.length === fixtures.length &&
      results.every((result) => result.pass) &&
      new Set(threadIds).size === threadIds.length,
    failure,
    model,
    reasoningEffort,
    serviceTier,
    prompt,
    promptWords: prompt.split(/\s+/u).length,
    behaviorPromptChanged: prompt !== baselinePrompt,
    peerReplyFormat: "unwrapped ordinary prose",
    archiveReplyFormat: "unwrapped ordinary prose",
    firstTools: Object.fromEntries(
      results.map((result) => [result.kind, result.firstTool]),
    ),
    passes: Object.fromEntries(
      results.map((result) => [result.kind, result.pass]),
    ),
    globalViolations,
    freshThreadCount: new Set(threadIds).size,
    totalThreadCount: threadIds.length,
    results,
  };
}

function makeFixtures(): Fixture[] {
  return [
    {
      id: "peer-only",
      kind: "peer-only",
      question:
        "In the fictional shoreline expedition log, what exact access phrase is recorded for the eelgrass light-response study Littoral-A?",
      answer: "Saffron Kelp-271",
      answerPeer: "node-93",
      answerInArchive: false,
      decoys: ["Cedar Foam-803"],
      peerReplies: {
        "node-42":
          "My field notes discuss Littoral-A, but the access-phrase line is missing from my copy.",
        "node-68":
          "The closest record I have is Littoral-AA, whose phrase is “Cedar Foam-803”; my notebook does not include Littoral-A's phrase.",
        "node-93":
          "For the eelgrass light-response study Littoral-A, my field notebook gives the access phrase as “Saffron Kelp-271”.",
        "node-17":
          "I have a tide table filed under Littoral-A, not the expedition access-phrase record.",
      },
      archiveReply:
        "The local archive has the survey map for Littoral-A, but its access-phrase page is absent.",
    },
    {
      id: "archive-only",
      kind: "archive-only",
      question:
        "In the fictional shoreline expedition log, what exact access phrase is recorded for the kelp-canopy isotope study Littoral-B?",
      answer: "Violet Current-614",
      answerInArchive: true,
      decoys: ["Marble Spray-442"],
      peerReplies: {
        "node-42":
          "My Littoral-B folder contains the equipment checklist, but no access phrase.",
        "node-68":
          "I only hold the neighboring Littoral-B2 record, whose phrase is “Marble Spray-442”; it is not the requested study.",
        "node-93":
          "The phrase line on my Littoral-B index card is water-damaged and unreadable.",
        "node-17":
          "My shoreline notes mention Littoral-B's sampling date but omit its access phrase.",
      },
      archiveReply:
        "The local expedition archive's Littoral-B entry lists the kelp-canopy isotope study access phrase as “Violet Current-614”.",
    },
    {
      id: "nobody",
      kind: "nobody",
      question:
        "In the fictional shoreline expedition log, what exact access phrase is recorded for the intertidal carbonate study Littoral-C?",
      answer: "Crimson Estuary-590",
      answerInArchive: false,
      decoys: [
        "Bronze Dune-118",
        "Quartz Gull-236",
        "Moss Inlet-354",
        "Pearl Breaker-472",
        "Slate Lagoon-681",
      ],
      peerReplies: {
        "node-42":
          "I found Littoral-C1, a neighboring sediment study, with phrase “Bronze Dune-118”; I have no Littoral-C entry.",
        "node-68":
          "My notebook covers Littoral-C2 rather than Littoral-C and records “Quartz Gull-236”.",
        "node-93":
          "The only nearby card I hold is Littoral-C3, marked “Moss Inlet-354”; the requested record is absent.",
        "node-17":
          "I can find Littoral-C4 with phrase “Pearl Breaker-472”, but not the intertidal carbonate study Littoral-C.",
      },
      archiveReply:
        "The archive search turns up only Littoral-C5, whose phrase is “Slate Lagoon-681”; no Littoral-C access-phrase page is present.",
    },
  ];
}

function assertRawProseFixtures(): void {
  for (const fixture of fixtures) {
    const replies = [...Object.values(fixture.peerReplies), fixture.archiveReply];
    for (const reply of replies) {
      assert(!reply.includes("NOT_FOUND"), "sentinel reply is forbidden");
      assert(!reply.trimStart().startsWith("{"), "JSON reply is forbidden");
      assert(
        !/\b(confidence|status|score)\s*:/iu.test(reply),
        "labeled reply is forbidden",
      );
    }
  }
}

function isExplicitlyUnresolved(text: string): boolean {
  return /\b(could not|couldn['’]t|cannot|can['’]t|unable|unresolved|not found|no (?:reliable )?answer|do not know|don['’]t know)\b/iu.test(
    text,
  );
}

function isPeer(value: string): value is PeerId {
  return peerIds.some((peer) => peer === value);
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
