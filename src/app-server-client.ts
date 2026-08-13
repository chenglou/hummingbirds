import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import type { JsonValue } from "./json.ts";

interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

type JsonRpcId = string | number;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (result: JsonValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AppServerRequest {
  id: JsonRpcId;
  method: string;
  params: JsonValue;
}

export type AppServerRequestHandler = (
  request: AppServerRequest,
) => Promise<JsonValue>;

interface NotificationWaiter {
  predicate: (message: JsonRpcMessage) => boolean;
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AppServerTurnOutcome {
  threadId: string;
  turnId: string;
  status: string;
  durationMs: number | null;
  startedAt: string;
  endedAt: string;
  finalText: string;
  agentMessages: Array<{ text: string; phase: string | null }>;
  completedItemTypes: string[];
  unexpectedToolItemTypes: string[];
  completedNotification: JsonValue;
}

export interface AppServerClientOptions {
  codexPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  enableShellTools?: boolean;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  serverRequestHandler?: AppServerRequestHandler;
}

export class AppServerClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly stdoutLogPath: string;
  private readonly stderrLogPath: string;
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly waiters = new Set<NotificationWaiter>();
  private readonly notifications: JsonRpcMessage[] = [];
  private readonly agentMessages = new Map<
    string,
    Array<{ text: string; phase: string | null }>
  >();
  private readonly completedItemTypes = new Map<string, string[]>();
  private readonly serverRequestHandler: AppServerRequestHandler | null;
  private nextId = 1;
  private closed = false;

  constructor(options: AppServerClientOptions) {
    this.stdoutLogPath = options.stdoutLogPath;
    this.stderrLogPath = options.stderrLogPath;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 300_000;
    this.serverRequestHandler = options.serverRequestHandler ?? null;
    const shellToolArgs = options.enableShellTools
      ? ["--enable", "shell_tool", "--enable", "unified_exec"]
      : ["--disable", "shell_tool", "--disable", "unified_exec"];
    this.process = spawn(
      options.codexPath,
      [
        "app-server",
        "--strict-config",
        "--enable",
        "fast_mode",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "browser_use",
        "--disable",
        "computer_use",
        "--disable",
        "image_generation",
        "--disable",
        "multi_agent",
        ...shellToolArgs,
        "-c",
        "mcp_servers.node_repl.enabled=false",
        "-c",
        "mcp_servers.openaiDeveloperDocs.enabled=false",
      ],
      {
        cwd: "/private/tmp",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      appendFileSync(this.stderrLogPath, chunk, "utf8");
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("close", (code, signal) => {
      this.closed = true;
      this.failAll(
        new Error(
          `Codex app-server closed (code ${String(code)}, signal ${String(signal)})`,
        ),
      );
    });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.receiveLine(line));
  }

  async initialize(): Promise<JsonValue> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "net_resident_benchmark",
        title: "Net resident-agent benchmark",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
          "turn/diff/updated",
          "turn/plan/updated",
          "thread/tokenUsage/updated",
        ],
      },
    });
    this.notify("initialized", {});
    return result;
  }

  async request(
    method: string,
    params: JsonValue = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<JsonValue> {
    if (this.closed) {
      throw new Error("Codex app-server is closed");
    }
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ method, id, params });
    return await response;
  }

  notify(method: string, params: JsonValue = {}): void {
    this.send({ method, params });
  }

  async runTurn(
    threadId: string,
    text: string,
    options: {
      effort: string;
      serviceTier: string;
      model: string;
      writableRoot?: string;
    },
  ): Promise<AppServerTurnOutcome> {
    const startedAt = new Date();
    const writableRoot = options.writableRoot;
    const response = asObject(
      await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        model: options.model,
        serviceTier: options.serviceTier,
        effort: options.effort,
        ...(writableRoot === undefined
          ? {}
          : { cwd: writableRoot, runtimeWorkspaceRoots: [writableRoot] }),
        sandboxPolicy:
          writableRoot === undefined
            ? { type: "readOnly", networkAccess: false }
            : {
                type: "workspaceWrite",
                writableRoots: [writableRoot],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              },
      }),
      "turn/start response",
    );
    const initialTurn = asObject(response["turn"], "turn/start response.turn");
    const turnId = asString(initialTurn["id"], "turn/start response.turn.id");
    const completed = await this.waitForNotification(
      (message) => {
        if (message.method !== "turn/completed") return false;
        const params = maybeObject(message.params);
        const turn = maybeObject(params?.["turn"]);
        return params?.["threadId"] === threadId && turn?.["id"] === turnId;
      },
      this.turnTimeoutMs,
    );
    const endedAt = new Date();
    const completedParams = asObject(
      completed.params,
      "turn/completed params",
    );
    const turn = asObject(completedParams["turn"], "turn/completed params.turn");
    const status = asString(turn["status"], "turn/completed turn.status");
    const messages = this.agentMessages.get(turnId) ?? [];
    const completedItemTypes = this.completedItemTypes.get(turnId) ?? [];
    const unexpectedToolItemTypes = completedItemTypes.filter((type) =>
      DISALLOWED_TOOL_ITEM_TYPES.has(type)
    );
    const final =
      [...messages].reverse().find((message) => message.phase === "final_answer") ??
      messages.at(-1);
    if (status !== "completed") {
      const error = maybeObject(turn["error"]);
      throw new Error(
        `Turn ${turnId} ended with ${status}: ${String(error?.["message"] ?? "unknown error")}`,
      );
    }
    if (final === undefined) {
      throw new Error(`Turn ${turnId} completed without an agent message`);
    }
    return {
      threadId,
      turnId,
      status,
      durationMs:
        typeof turn["durationMs"] === "number" ? turn["durationMs"] : null,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      finalText: final.text,
      agentMessages: messages,
      completedItemTypes,
      unexpectedToolItemTypes,
      completedNotification: completedParams,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.lines.close();
    this.process.stdin.end();
    const exited = new Promise<void>((resolve) => {
      this.process.once("close", () => resolve());
    });
    const timer = setTimeout(() => {
      if (!this.closed) this.process.kill("SIGTERM");
    }, 1_000);
    await exited;
    clearTimeout(timer);
  }

  private waitForNotification(
    predicate: (message: JsonRpcMessage) => boolean,
    timeoutMs: number,
  ): Promise<JsonRpcMessage> {
    const bufferedIndex = this.notifications.findIndex(predicate);
    if (bufferedIndex >= 0) {
      const buffered = this.notifications.splice(bufferedIndex, 1)[0];
      if (buffered !== undefined) return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        predicate,
        resolve: (message) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("Timed out waiting for app-server notification"));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private receiveLine(line: string): void {
    appendFileSync(this.stdoutLogPath, `${line}\n`, "utf8");
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      appendFileSync(
        this.stderrLogPath,
        `Could not parse app-server stdout line: ${line}\n`,
        "utf8",
      );
      return;
    }

    if (message.method !== undefined && message.id !== undefined) {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params ?? null,
      });
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(
          new Error(
            `App-server request failed (${message.error.code}): ${message.error.message}`,
          ),
        );
      } else if (message.result === undefined) {
        pending.reject(new Error(`App-server response ${message.id} has no result`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.captureAgentMessage(message);
    for (const waiter of this.waiters) {
      if (waiter.predicate(message)) {
        waiter.resolve(message);
        return;
      }
    }
    this.notifications.push(message);
    if (this.notifications.length > 2_000) this.notifications.shift();
  }

  private async handleServerRequest(request: AppServerRequest): Promise<void> {
    try {
      if (this.serverRequestHandler === null) {
        throw new Error(`Unsupported server request ${request.method}`);
      }
      const result = await this.serverRequestHandler(request);
      if (!this.closed) this.send({ id: request.id, result });
    } catch (error: unknown) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.send({
        id: request.id,
        error: { code: -32_603, message },
      });
    }
  }

  private captureAgentMessage(message: JsonRpcMessage): void {
    if (message.method !== "item/completed") return;
    const params = maybeObject(message.params);
    const item = maybeObject(params?.["item"]);
    const turnId = params?.["turnId"];
    const type = item?.["type"];
    if (
      item === null ||
      typeof turnId !== "string" ||
      typeof type !== "string"
    ) {
      return;
    }
    const itemTypes = this.completedItemTypes.get(turnId) ?? [];
    itemTypes.push(type);
    this.completedItemTypes.set(turnId, itemTypes);
    if (type !== "agentMessage") return;
    const text = item["text"];
    const phase = item["phase"];
    if (typeof text !== "string") return;
    const current = this.agentMessages.get(turnId) ?? [];
    current.push({ text, phase: typeof phase === "string" ? phase : null });
    this.agentMessages.set(turnId, current);
  }

  private send(message: JsonRpcMessage): void {
    if (this.closed) throw new Error("Codex app-server is closed");
    const line = JSON.stringify(message);
    appendFileSync(this.stdoutLogPath, `> ${line}\n`, "utf8");
    this.process.stdin.write(`${line}\n`);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const waiter of this.waiters) waiter.reject(error);
  }
}

const DISALLOWED_TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

function asObject(value: JsonValue | undefined, label: string): {
  [key: string]: JsonValue;
} {
  const object = maybeObject(value);
  if (object === null) throw new Error(`${label} must be an object`);
  return object;
}

function maybeObject(
  value: JsonValue | undefined,
): { [key: string]: JsonValue } | null {
  return value !== null && value !== undefined && !Array.isArray(value) &&
      typeof value === "object"
    ? value
    : null;
}

function asString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
