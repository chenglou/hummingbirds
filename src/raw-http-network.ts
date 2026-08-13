import { randomUUID } from "node:crypto";

const REQUEST_ID_HEADER = "x-net-request-id";
const VISITED_HEADER = "x-net-visited";

export interface RawHttpNodeSpec {
  id: string;
  port: number;
  peerIds: readonly string[];
}

export interface RawHttpRequestContext {
  requestId: string;
  nodeId: string;
  visitedNodeIds: readonly string[];
}

export interface RawHttpAnswer {
  requestId: string;
  status: number;
  ok: boolean;
  body: string;
}

export interface RawHttpPeerAnswer extends RawHttpAnswer {
  fromNodeId: string;
  toNodeId: string;
  address: string;
}

export type RawHttpTraceEvent =
  | {
      seq: number;
      at: string;
      kind: "request_started";
      requestId: string;
      nodeId: string;
      address: string;
      question: string;
      visitedNodeIds: string[];
    }
  | {
      seq: number;
      at: string;
      kind: "request_completed";
      requestId: string;
      nodeId: string;
      address: string;
      status: number;
      answer: string;
      durationMs: number;
    }
  | {
      seq: number;
      at: string;
      kind: "request_rejected";
      requestId: string;
      nodeId: string;
      address: string;
      status: number;
      reason: string;
      visitedNodeIds: string[];
    }
  | {
      seq: number;
      at: string;
      kind: "peer_call_started";
      requestId: string;
      fromNodeId: string;
      toNodeId: string;
      address: string;
      question: string;
      visitedNodeIds: string[];
    }
  | {
      seq: number;
      at: string;
      kind: "peer_call_completed";
      requestId: string;
      fromNodeId: string;
      toNodeId: string;
      address: string;
      status: number;
      answer: string;
      durationMs: number;
    };

type RawHttpTraceInput = RawHttpTraceEvent extends infer Event
  ? Event extends RawHttpTraceEvent
    ? Omit<Event, "seq" | "at">
    : never
  : never;

export type RawHttpResponder = (
  node: RawHttpNodeSpec,
  question: string,
  context: RawHttpRequestContext,
) => Promise<string>;

export interface RawHttpNetworkOptions {
  hostname?: string;
  peerTimeoutMs?: number;
}

export class RawHttpNetwork {
  private readonly hostname: string;
  private readonly peerTimeoutMs: number;
  private readonly specs = new Map<string, RawHttpNodeSpec>();
  private readonly servers = new Map<
    string,
    ReturnType<typeof Bun.serve>
  >();
  private readonly responder: RawHttpResponder;
  private readonly traceEvents: RawHttpTraceEvent[] = [];

  constructor(
    specs: readonly RawHttpNodeSpec[],
    responder: RawHttpResponder,
    options: RawHttpNetworkOptions = {},
  ) {
    this.hostname = options.hostname ?? "127.0.0.1";
    this.peerTimeoutMs = options.peerTimeoutMs ?? 300_000;
    this.responder = responder;
    this.validateSpecs(specs);
    for (const spec of specs) this.specs.set(spec.id, spec);
    try {
      for (const spec of specs) {
        const server = Bun.serve({
          hostname: this.hostname,
          port: spec.port,
          fetch: async (request) => await this.handleRequest(spec, request),
        });
        this.servers.set(spec.id, server);
      }
    } catch (error: unknown) {
      for (const server of this.servers.values()) void server.stop(true);
      throw error;
    }
  }

  nodeIds(): string[] {
    return [...this.specs.keys()];
  }

  urlFor(nodeId: string): string {
    const server = this.servers.get(nodeId);
    if (server === undefined) throw new Error(`Unknown HTTP node: ${nodeId}`);
    return `http://${this.hostname}:${server.port}/ask`;
  }

  peerUrlsFor(nodeId: string): Array<{ id: string; address: string }> {
    const spec = this.requiredSpec(nodeId);
    return spec.peerIds.map((peerId) => ({
      id: peerId,
      address: this.urlFor(peerId),
    }));
  }

  trace(): RawHttpTraceEvent[] {
    return this.traceEvents.map((event) => structuredClone(event));
  }

  async ask(nodeId: string, question: string): Promise<RawHttpAnswer> {
    const requestId = randomUUID();
    const response = await fetch(this.urlFor(nodeId), {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        [REQUEST_ID_HEADER]: requestId,
        [VISITED_HEADER]: "",
      },
      body: question,
    });
    return {
      requestId,
      status: response.status,
      ok: response.ok,
      body: await response.text(),
    };
  }

  async forward(
    fromNodeId: string,
    address: string,
    question: string,
    context: RawHttpRequestContext,
  ): Promise<RawHttpPeerAnswer> {
    if (context.nodeId !== fromNodeId) {
      throw new Error(
        `Request context belongs to ${context.nodeId}, not ${fromNodeId}`,
      );
    }
    const from = this.requiredSpec(fromNodeId);
    const peer = from.peerIds
      .map((peerId) => ({ id: peerId, address: this.urlFor(peerId) }))
      .find((candidate) => candidate.address === address);
    if (peer === undefined) {
      throw new Error(`${fromNodeId} cannot call non-peer address ${address}`);
    }
    const startedAt = Date.now();
    this.record({
      kind: "peer_call_started",
      requestId: context.requestId,
      fromNodeId,
      toNodeId: peer.id,
      address,
      question,
      visitedNodeIds: [...context.visitedNodeIds],
    });
    let response: Response;
    try {
      response = await fetch(address, {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          [REQUEST_ID_HEADER]: context.requestId,
          [VISITED_HEADER]: context.visitedNodeIds.join(","),
        },
        body: question,
        signal: AbortSignal.timeout(this.peerTimeoutMs),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.record({
        kind: "peer_call_completed",
        requestId: context.requestId,
        fromNodeId,
        toNodeId: peer.id,
        address,
        status: 599,
        answer: message,
        durationMs: Date.now() - startedAt,
      });
      return {
        requestId: context.requestId,
        fromNodeId,
        toNodeId: peer.id,
        address,
        status: 599,
        ok: false,
        body: message,
      };
    }
    const body = await response.text();
    this.record({
      kind: "peer_call_completed",
      requestId: context.requestId,
      fromNodeId,
      toNodeId: peer.id,
      address,
      status: response.status,
      answer: body,
      durationMs: Date.now() - startedAt,
    });
    return {
      requestId: context.requestId,
      fromNodeId,
      toNodeId: peer.id,
      address,
      status: response.status,
      ok: response.ok,
      body,
    };
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.servers.values()].map(async (server) => await server.stop(true)),
    );
    this.servers.clear();
  }

  private async handleRequest(
    spec: RawHttpNodeSpec,
    request: Request,
  ): Promise<Response> {
    const address = this.urlFor(spec.id);
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? randomUUID();
    const visitedNodeIds = parseVisited(request.headers.get(VISITED_HEADER));
    if (new URL(request.url).pathname !== "/ask") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (visitedNodeIds.includes(spec.id)) {
      const reason = `Cycle rejected at ${spec.id}`;
      this.record({
        kind: "request_rejected",
        requestId,
        nodeId: spec.id,
        address,
        status: 508,
        reason,
        visitedNodeIds,
      });
      return new Response(reason, {
        status: 508,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const question = await request.text();
    if (question.trim().length === 0) {
      return new Response("Question must not be empty", { status: 400 });
    }
    const context: RawHttpRequestContext = {
      requestId,
      nodeId: spec.id,
      visitedNodeIds: [...visitedNodeIds, spec.id],
    };
    const startedAt = Date.now();
    this.record({
      kind: "request_started",
      requestId,
      nodeId: spec.id,
      address,
      question,
      visitedNodeIds: [...context.visitedNodeIds],
    });
    try {
      const answer = await this.responder(spec, question, context);
      this.record({
        kind: "request_completed",
        requestId,
        nodeId: spec.id,
        address,
        status: 200,
        answer,
        durationMs: Date.now() - startedAt,
      });
      return new Response(answer, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.record({
        kind: "request_completed",
        requestId,
        nodeId: spec.id,
        address,
        status: 500,
        answer: message,
        durationMs: Date.now() - startedAt,
      });
      return new Response(message, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  }

  private requiredSpec(nodeId: string): RawHttpNodeSpec {
    const spec = this.specs.get(nodeId);
    if (spec === undefined) throw new Error(`Unknown HTTP node: ${nodeId}`);
    return spec;
  }

  private record(event: RawHttpTraceInput): void {
    this.traceEvents.push({
      ...event,
      seq: this.traceEvents.length,
      at: new Date().toISOString(),
    } as RawHttpTraceEvent);
  }

  private validateSpecs(specs: readonly RawHttpNodeSpec[]): void {
    const ids = new Set<string>();
    for (const spec of specs) {
      if (spec.id.length === 0 || spec.id.includes(",")) {
        throw new Error(`Invalid HTTP node ID: ${spec.id}`);
      }
      if (ids.has(spec.id)) throw new Error(`Duplicate HTTP node: ${spec.id}`);
      ids.add(spec.id);
      if (!Number.isInteger(spec.port) || spec.port < 0 || spec.port > 65_535) {
        throw new Error(`Invalid port for ${spec.id}: ${spec.port}`);
      }
    }
    for (const spec of specs) {
      for (const peerId of spec.peerIds) {
        if (!ids.has(peerId)) {
          throw new Error(`${spec.id} has unknown peer ${peerId}`);
        }
        if (peerId === spec.id) {
          throw new Error(`${spec.id} cannot list itself as a peer`);
        }
      }
    }
  }
}

function parseVisited(header: string | null): string[] {
  if (header === null || header.length === 0) return [];
  return header.split(",").filter((value) => value.length > 0);
}
