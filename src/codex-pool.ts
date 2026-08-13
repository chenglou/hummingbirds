import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalStringify,
  readJson,
  type JsonValue,
} from "./json.ts";
import {
  parseProposedTransition,
  type ProposedTransition,
  type WorkerEnvelope,
} from "./model.ts";
import { routingSemanticError } from "./routing-contract.ts";
import { RunStore } from "./store.ts";

const args = process.argv.slice(2);
const runPath = resolve(requiredArg(args, 0, "run directory"));
const concurrency = positiveInteger(args[1] ?? "5", "concurrency");
const model = args[2] ?? "gpt-5.6-luna";
const reasoningEffort = args[3] ?? "low";
const serviceTier = args[4] ?? "fast";
const maxAttempts = positiveInteger(args[5] ?? "3", "max attempts");
const maxTurns = positiveInteger(args[6] ?? "500", "max turns");
const codexPath = findCodex();
const store = new RunStore(runPath);
const metricsPath = join(runPath, "worker-metrics.jsonl");

let leasedTurns = 0;
let stop = false;
const failures: string[] = [];

await Promise.all(
  Array.from({ length: concurrency }, (_, index) => workerLoop(index + 1)),
);

const view = store.loadView();
const unfinished = [...view.messages.values()].filter(
  (message) => message.status === "queued" || message.status === "leased",
);
const summary = {
  ok: failures.length === 0 && unfinished.length === 0,
  runPath,
  concurrency,
  model,
  reasoningEffort,
  serviceTier,
  leasedTurns,
  failures,
  unfinishedMessages: unfinished.length,
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (!summary.ok) {
  process.exitCode = 1;
}

async function workerLoop(workerNumber: number): Promise<void> {
  const workerId = `codex-cli-${workerNumber}`;
  while (!stop) {
    const envelope = store.leaseNext(workerId);
    if (envelope === null) {
      const current = store.loadView();
      const hasOpenMessages = [...current.messages.values()].some(
        (message) =>
          message.status === "queued" || message.status === "leased",
      );
      if (!hasOpenMessages) {
        return;
      }
      await delay(25);
      continue;
    }

    leasedTurns += 1;
    if (leasedTurns > maxTurns) {
      const reason = `Exceeded maximum turn count ${maxTurns}`;
      store.fail(envelope.leaseId, reason);
      failures.push(reason);
      stop = true;
      return;
    }

    const failure = await executeLease(envelope, workerId);
    if (failure !== null) {
      store.fail(envelope.leaseId, failure);
      failures.push(failure);
      stop = true;
      return;
    }
  }
}

async function executeLease(
  envelope: WorkerEnvelope,
  workerId: string,
): Promise<string | null> {
  let lastError = "worker attempt failed";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const runtimeRoot = join(runPath, "turns", envelope.leaseId, "runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const finalPath = join(runtimeRoot, `attempt-${attempt}.final.txt`);
    const stdoutPath = join(runtimeRoot, `attempt-${attempt}.stdout.log`);
    const stderrPath = join(runtimeRoot, `attempt-${attempt}.stderr.log`);
    const startedAt = new Date();
    const invocation = await invokeCodex(
      envelope,
      finalPath,
      attempt === 1 ? null : lastError,
    );
    const endedAt = new Date();
    writeFileSync(stdoutPath, invocation.stdout, "utf8");
    writeFileSync(stderrPath, invocation.stderr, "utf8");

    let accepted = false;
    let error: string | null = null;
    if (invocation.exitCode !== 0) {
      error = `Codex exited with ${invocation.exitCode}`;
    } else if (!existsSync(finalPath)) {
      error = "Codex did not write a final response";
    } else {
      let proposal: ProposedTransition | null = null;
      try {
        proposal = parseProposedTransition(readJson(finalPath));
      } catch {
        // submitRaw records the malformed response and its parse error.
      }
      const semanticError =
        proposal === null
          ? null
          : routingSemanticError(envelope, proposal);
      if (semanticError !== null) {
        store.rejectRaw(envelope.leaseId, finalPath, semanticError);
        error = semanticError;
      } else {
        const submitted = store.submitRaw(envelope.leaseId, finalPath);
        accepted = submitted.accepted;
        error = submitted.accepted ? null : submitted.error;
      }
    }

    appendMetric({
      leaseId: envelope.leaseId,
      requestId: envelope.incoming.requestId,
      nodeId: envelope.node.id,
      workerId,
      attempt,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      exitCode: invocation.exitCode,
      accepted,
      error,
      tokensUsed: extractTokens(invocation.stdout, invocation.stderr),
    });

    if (accepted) {
      return null;
    }
    lastError = error ?? lastError;
  }
  return `Lease ${envelope.leaseId} failed after ${maxAttempts} attempts: ${lastError}`;
}

async function invokeCodex(
  envelope: WorkerEnvelope,
  finalPath: string,
  previousError: string | null,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const prompt = [
    envelope.worker?.instructions ?? "Execute one logical-node turn.",
    "Do not use tools or inspect ambient files.",
    previousError === null
      ? ""
      : `Your previous proposal was rejected: ${previousError}. Correct that error.`,
    "The complete worker envelope follows:",
    canonicalStringify(envelope as unknown as JsonValue),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const codexArgs = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--strict-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    "-c",
    `service_tier=${JSON.stringify(serviceTier)}`,
    "-c",
    "features.fast_mode=true",
    "--output-last-message",
    finalPath,
    "--color",
    "never",
    "-",
  ];

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(codexPath, codexArgs, {
      cwd: "/private/tmp",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

function appendMetric(metric: Record<string, JsonValue>): void {
  appendFileSync(
    metricsPath,
    `${canonicalStringify(metric as unknown as JsonValue)}\n`,
    "utf8",
  );
}

function extractTokens(stdout: string, stderr: string): number | null {
  const match = `${stdout}\n${stderr}`.match(/tokens used\s+([\d,]+)/i);
  return match === null ? null : Number(match[1]?.replaceAll(",", ""));
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

function requiredArg(
  values: string[],
  index: number,
  label: string,
): string {
  const value = values[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
