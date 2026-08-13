import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppServerClient, type AppServerTurnOutcome } from "./app-server-client.ts";
import {
  canonicalStringify,
  readJson,
  type JsonValue,
} from "./json.ts";
import {
  parseProposedTransition,
  type NodeRuntime,
  type ProposedTransition,
  type WorkerEnvelope,
} from "./model.ts";
import { routingSemanticError } from "./routing-contract.ts";
import { RunStore } from "./store.ts";

const args = process.argv.slice(2);
const runPath = resolve(requiredArg(args, 0, "run directory"));
const expectedResidents = positiveInteger(args[1] ?? "24", "resident count");
const model = args[2] ?? "gpt-5.6-luna";
const reasoningEffort = args[3] ?? "low";
const serviceTier = args[4] ?? "fast";
const maxAttempts = positiveInteger(args[5] ?? "3", "max attempts");
const maxTurns = positiveInteger(args[6] ?? "50", "max turns");
const codexPath = findCodex();
const store = new RunStore(runPath);
const runtimeRoot = join(runPath, "resident-runtime");
const metricsPath = join(runPath, "resident-worker-metrics.jsonl");
const benchmarkPath = join(runPath, "resident-benchmark.json");
mkdirSync(runtimeRoot, { recursive: true });

const initialView = store.loadView();
if (initialView.run === null) throw new Error("Run is not initialized");
if (initialView.nodes.size !== expectedResidents) {
  throw new Error(
    `Expected ${expectedResidents} resident nodes, found ${initialView.nodes.size}`,
  );
}

const client = new AppServerClient({
  codexPath,
  stdoutLogPath: join(runtimeRoot, "app-server.jsonl"),
  stderrLogPath: join(runtimeRoot, "app-server.stderr.log"),
});
const benchmarkStartedAt = new Date();
const failures: string[] = [];
const threadIds = new Map<string, string>();
const threadStartMetrics: JsonValue[] = [];
const warmupMetrics: JsonValue[] = [];
const turnMetrics: JsonValue[] = [];
let loadedBefore: string[] = [];
let loadedAfter: string[] = [];
let timedStartedAt: Date | null = null;
let timedEndedAt: Date | null = null;

try {
  await client.initialize();

  const threadStartAt = new Date();
  await Promise.all(
    [...initialView.nodes.values()].map(async (node) => {
      const startedAt = new Date();
      const result = expectObject(
        await client.request("thread/start", threadParams(node)),
        `thread/start ${node.definition.id}`,
      );
      const thread = expectObject(
        result["thread"],
        `thread/start ${node.definition.id}.thread`,
      );
      const threadId = expectString(
        thread["id"],
        `thread/start ${node.definition.id}.thread.id`,
      );
      threadIds.set(node.definition.id, threadId);
      threadStartMetrics.push({
        nodeId: node.definition.id,
        threadId,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        model: typeof result["model"] === "string" ? result["model"] : null,
        serviceTier:
          typeof result["serviceTier"] === "string"
            ? result["serviceTier"]
            : null,
        reasoningEffort:
          typeof result["reasoningEffort"] === "string"
            ? result["reasoningEffort"]
            : null,
      });
    }),
  );
  const threadStartEndedAt = new Date();

  const warmupStartedAt = new Date();
  await Promise.all(
    [...initialView.nodes.keys()].map(async (nodeId) => {
      const threadId = requiredThreadId(threadIds, nodeId);
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const outcome = await client.runTurn(
            threadId,
            `WARMUP ONLY. Do not perform a logical node turn. Reply exactly: READY ${nodeId}`,
            { model, effort: reasoningEffort, serviceTier },
          );
          if (outcome.finalText.trim() !== `READY ${nodeId}`) {
            throw new Error(
              `Unexpected warm-up reply: ${JSON.stringify(outcome.finalText)}`,
            );
          }
          if (outcome.unexpectedToolItemTypes.length > 0) {
            throw new Error(
              `Warm-up used tools: ${outcome.unexpectedToolItemTypes.join(", ")}`,
            );
          }
          warmupMetrics.push({
            nodeId,
            attempt,
            threadId,
            turnId: outcome.turnId,
            durationMs: wallDuration(outcome),
            modelDurationMs: outcome.durationMs,
            ready: true,
            response: outcome.finalText,
            completedItemTypes: outcome.completedItemTypes,
          });
          return;
        } catch (error: unknown) {
          lastError = toError(error);
          warmupMetrics.push({
            nodeId,
            attempt,
            threadId,
            error: lastError.message,
          });
        }
      }
      throw new Error(
        `Warm-up failed for ${nodeId}: ${lastError?.message ?? "unknown error"}`,
      );
    }),
  );
  const warmupEndedAt = new Date();

  loadedBefore = await loadedThreadIds(client);
  assertResidentsLoaded(threadIds, loadedBefore, "before timed question");

  timedStartedAt = new Date();
  let leasedTurns = 0;
  while (true) {
    const envelope = store.leaseNext("resident-app-server");
    if (envelope === null) break;
    leasedTurns += 1;
    if (leasedTurns > maxTurns) {
      const reason = `Exceeded maximum turn count ${maxTurns}`;
      store.fail(envelope.leaseId, reason);
      failures.push(reason);
      break;
    }
    const failure = await executeLease(envelope);
    if (failure !== null) {
      store.fail(envelope.leaseId, failure);
      failures.push(failure);
      break;
    }
  }
  timedEndedAt = new Date();

  loadedAfter = await loadedThreadIds(client);
  assertResidentsLoaded(threadIds, loadedAfter, "after timed question");

  const finalView = store.loadView();
  const unfinished = [...finalView.messages.values()].filter(
    (message) => message.status === "queued" || message.status === "leased",
  );
  const benchmark = {
    ok: failures.length === 0 && unfinished.length === 0,
    runPath,
    model,
    reasoningEffort,
    serviceTier,
    residentThreads: threadIds.size,
    benchmarkStartedAt: benchmarkStartedAt.toISOString(),
    threadStartStartedAt: threadStartAt.toISOString(),
    threadStartEndedAt: threadStartEndedAt.toISOString(),
    threadStartDurationMs:
      threadStartEndedAt.getTime() - threadStartAt.getTime(),
    warmupStartedAt: warmupStartedAt.toISOString(),
    warmupEndedAt: warmupEndedAt.toISOString(),
    warmupDurationMs: warmupEndedAt.getTime() - warmupStartedAt.getTime(),
    timedStartedAt: timedStartedAt.toISOString(),
    timedEndedAt: timedEndedAt.toISOString(),
    timedDurationMs: timedEndedAt.getTime() - timedStartedAt.getTime(),
    loadedBefore: loadedBefore.length,
    loadedAfter: loadedAfter.length,
    leasedTurns,
    failures,
    unfinishedMessages: unfinished.length,
    threads: threadStartMetrics,
    warmups: warmupMetrics,
    turns: turnMetrics,
  } as const;
  writeFileSync(
    benchmarkPath,
    `${JSON.stringify(benchmark, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(benchmark)}\n`);
  if (!benchmark.ok) process.exitCode = 1;
} catch (error: unknown) {
  const failure = toError(error).message;
  failures.push(failure);
  const partial = {
    ok: false,
    runPath,
    model,
    reasoningEffort,
    serviceTier,
    residentThreads: threadIds.size,
    benchmarkStartedAt: benchmarkStartedAt.toISOString(),
    timedStartedAt: timedStartedAt?.toISOString() ?? null,
    timedEndedAt: timedEndedAt?.toISOString() ?? null,
    loadedBefore: loadedBefore.length,
    loadedAfter: loadedAfter.length,
    failures,
    threads: threadStartMetrics,
    warmups: warmupMetrics,
    turns: turnMetrics,
  };
  writeFileSync(benchmarkPath, `${JSON.stringify(partial, null, 2)}\n`, "utf8");
  process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} finally {
  await client.close();
}

async function executeLease(envelope: WorkerEnvelope): Promise<string | null> {
  const threadId = requiredThreadId(threadIds, envelope.node.id);
  let lastError = "resident attempt failed";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptRoot = join(runPath, "turns", envelope.leaseId, "runtime");
    mkdirSync(attemptRoot, { recursive: true });
    const finalPath = join(attemptRoot, `resident-attempt-${attempt}.final.txt`);
    const detailPath = join(attemptRoot, `resident-attempt-${attempt}.json`);
    let outcome: AppServerTurnOutcome | null = null;
    let accepted = false;
    let error: string | null = null;
    const startedAt = new Date();
    try {
      outcome = await client.runTurn(
        threadId,
        logicalTurnPrompt(envelope, attempt === 1 ? null : lastError),
        { model, effort: reasoningEffort, serviceTier },
      );
      if (outcome.unexpectedToolItemTypes.length > 0) {
        throw new Error(
          `Logical turn used tools: ${outcome.unexpectedToolItemTypes.join(", ")}`,
        );
      }
      writeFileSync(finalPath, outcome.finalText, "utf8");
      writeFileSync(detailPath, `${JSON.stringify(outcome, null, 2)}\n`, "utf8");
      let proposal: ProposedTransition | null = null;
      try {
        proposal = parseProposedTransition(readJson(finalPath));
      } catch {
        // submitRaw records malformed output and the parse error.
      }
      const semanticError =
        proposal === null ? null : routingSemanticError(envelope, proposal);
      if (semanticError !== null) {
        store.rejectRaw(envelope.leaseId, finalPath, semanticError);
        error = semanticError;
      } else {
        const submitted = store.submitRaw(envelope.leaseId, finalPath);
        accepted = submitted.accepted;
        error = submitted.accepted ? null : submitted.error;
      }
    } catch (caught: unknown) {
      error = toError(caught).message;
    }
    const endedAt = new Date();
    const metric = {
      leaseId: envelope.leaseId,
      requestId: envelope.incoming.requestId,
      nodeId: envelope.node.id,
      threadId,
      attempt,
      turnId: outcome?.turnId ?? null,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      modelDurationMs: outcome?.durationMs ?? null,
      completedItemTypes: outcome?.completedItemTypes ?? [],
      accepted,
      error,
    };
    turnMetrics.push(metric);
    appendFileSync(metricsPath, `${JSON.stringify(metric)}\n`, "utf8");
    if (accepted) return null;
    lastError = error ?? lastError;
  }
  return `Lease ${envelope.leaseId} failed after ${maxAttempts} attempts: ${lastError}`;
}

function threadParams(node: NodeRuntime): JsonValue {
  const run = initialView.run;
  if (run === null) throw new Error("Run is not initialized");
  const workerInstructions =
    run.worker?.instructions ?? "Execute one logical-node turn.";
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
    baseInstructions: [
      `You are resident logical node ${node.definition.id}.`,
      "You do not use tools, inspect files, browse, or contact agents yourself.",
      "A LOGICAL TURN message contains the authoritative current envelope. If it conflicts with conversation history, trust the envelope.",
      workerInstructions,
      node.definition.systemPrompt,
      `Immutable private corpus for ${node.definition.id}:`,
      canonicalStringify(node.definition.corpus),
      "Special case: a user message beginning WARMUP ONLY is only a health check. Do not execute the node protocol; reply with exactly the READY text requested and nothing else.",
    ].join("\n\n"),
    developerInstructions:
      "Stay concise. For LOGICAL TURN, output only the requested JSON object and no markdown fence.",
    ephemeral: true,
    environments: [],
    dynamicTools: [],
  };
}

function logicalTurnPrompt(
  envelope: WorkerEnvelope,
  previousError: string | null,
): string {
  return [
    "LOGICAL TURN. Execute exactly one turn for your resident node.",
    "The envelope below is the authoritative current state and incoming message.",
    previousError === null
      ? ""
      : `Your previous proposal was rejected: ${previousError}. Correct it.`,
    canonicalStringify(envelope as unknown as JsonValue),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

async function loadedThreadIds(clientValue: AppServerClient): Promise<string[]> {
  const result = expectObject(
    await clientValue.request("thread/loaded/list", {}),
    "thread/loaded/list",
  );
  const data = result["data"];
  if (!Array.isArray(data) || !data.every((value) => typeof value === "string")) {
    throw new Error("thread/loaded/list.data must be an array of strings");
  }
  return data as string[];
}

function assertResidentsLoaded(
  residents: ReadonlyMap<string, string>,
  loaded: readonly string[],
  label: string,
): void {
  const loadedSet = new Set(loaded);
  const missing = [...residents.entries()]
    .filter(([, threadId]) => !loadedSet.has(threadId))
    .map(([nodeId]) => nodeId);
  if (missing.length > 0) {
    throw new Error(`Missing resident threads ${label}: ${missing.join(", ")}`);
  }
}

function requiredThreadId(
  residents: ReadonlyMap<string, string>,
  nodeId: string,
): string {
  const threadId = residents.get(nodeId);
  if (threadId === undefined) throw new Error(`No resident thread for ${nodeId}`);
  return threadId;
}

function wallDuration(outcome: AppServerTurnOutcome): number {
  return new Date(outcome.endedAt).getTime() - new Date(outcome.startedAt).getTime();
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

function requiredArg(
  values: readonly string[],
  index: number,
  name: string,
): string {
  const value = values[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
