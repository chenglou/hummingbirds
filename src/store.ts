import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  canonicalStringify,
  hashJson,
  hashText,
  parseJsonText,
  readJson,
  type JsonValue,
} from "./json.ts";
import {
  PROTOCOL_VERSION,
  parseEvent,
  parseNodeDefinition,
  parseProposedTransition,
  type Event,
  type Lease,
  type LeaseRuntime,
  type Message,
  type NodeDefinition,
  type NodeRuntime,
  type ProposedTransition,
  type RunDefinition,
  type RunCompletion,
  type RunView,
  type WorkerManifest,
  type WorkerEnvelope,
} from "./model.ts";

export class RunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  initialize(runId: string, worker: WorkerManifest | null = null): RunDefinition {
    mkdirSync(this.root, { recursive: true });
    return this.withLock(() => {
      const eventPath = this.eventPath();
      if (existsSync(eventPath)) {
        throw new Error(`Run already exists at ${this.root}`);
      }
      mkdirSync(join(this.root, "nodes"), { recursive: true });
      mkdirSync(join(this.root, "turns"), { recursive: true });
      const run: RunDefinition = {
        id: runId,
        protocolVersion: PROTOCOL_VERSION,
        createdAt: now(),
        worker,
      };
      writeJsonAtomic(join(this.root, "run.json"), run as unknown as JsonValue);
      this.appendEvent({
        seq: 0,
        at: run.createdAt,
        kind: "run_created",
        run,
      });
      return run;
    });
  }

  addNodeFromFile(path: string): NodeDefinition {
    return this.addNode(parseNodeDefinition(readJson(path)));
  }

  addNode(node: NodeDefinition): NodeDefinition {
    return this.withLock(() => {
      const view = this.loadView();
      assertInitialized(view);
      assertOpen(view);
      if (view.nodes.has(node.id)) {
        throw new Error(`Node already exists: ${node.id}`);
      }
      const event: Event = {
        seq: this.nextSeq(),
        at: now(),
        kind: "node_added",
        node,
      };
      this.appendEvent(event);
      writeJsonAtomic(
        join(this.root, "nodes", node.id, "definition.json"),
        node as unknown as JsonValue,
      );
      this.writeNodeSnapshot(node.id, 0, node.initialState);
      return node;
    });
  }

  enqueue(
    to: string,
    body: JsonValue,
    callerId: string | null = null,
    requestId: string = randomUUID(),
  ): Message {
    return this.withLock(() => {
      const view = this.loadView();
      assertInitialized(view);
      assertOpen(view);
      if (!view.nodes.has(to)) {
        throw new Error(`Unknown destination node: ${to}`);
      }
      if (callerId !== null && !view.nodes.has(callerId)) {
        throw new Error(`Unknown source node: ${callerId}`);
      }
      const message: Message = {
        id: randomUUID(),
        requestId,
        callerId,
        to,
        body,
        causationId: null,
      };
      this.appendEvent({
        seq: this.nextSeq(),
        at: now(),
        kind: "message_queued",
        message,
      });
      return message;
    });
  }

  leaseNext(workerId: string): WorkerEnvelope | null {
    return this.withLock(() => {
      const view = this.loadView();
      const run = assertInitialized(view);
      assertOpen(view);
      const busyNodes = new Set(
        [...view.leases.values()]
          .filter((lease) => lease.status === "active")
          .map((lease) => lease.lease.nodeId),
      );
      const messageRuntime = [...view.messages.values()].find(
        (candidate) =>
          candidate.status === "queued" && !busyNodes.has(candidate.message.to),
      );
      if (messageRuntime === undefined) {
        return null;
      }
      const node = view.nodes.get(messageRuntime.message.to);
      if (node === undefined) {
        throw new Error(`Missing node for message: ${messageRuntime.message.id}`);
      }
      const lease: Lease = {
        id: randomUUID(),
        workerId,
        messageId: messageRuntime.message.id,
        nodeId: node.definition.id,
        expectedGeneration: node.generation,
        createdAt: now(),
      };
      const envelope = makeEnvelope(run, lease, node, messageRuntime.message);
      const inputHash = hashJson(envelope as unknown as JsonValue);
      this.appendEvent({
        seq: this.nextSeq(),
        at: now(),
        kind: "turn_leased",
        lease,
        inputHash,
      });
      writeJsonAtomic(
        join(this.root, "turns", lease.id, "input.json"),
        envelope as unknown as JsonValue,
      );
      return envelope;
    });
  }

  commitFromFile(leaseId: string, path: string): ProposedTransition {
    return this.commit(leaseId, parseProposedTransition(readJson(path)));
  }

  commit(leaseId: string, proposal: ProposedTransition): ProposedTransition {
    return this.withLock(() => {
      const view = this.loadView();
      assertInitialized(view);
      assertOpen(view);
      return this.commitLocked(view, leaseId, proposal);
    });
  }

  fail(leaseId: string, reason: string): void {
    this.withLock(() => {
      const view = this.loadView();
      assertInitialized(view);
      assertOpen(view);
      const leaseRuntime = view.leases.get(leaseId);
      if (leaseRuntime === undefined || leaseRuntime.status !== "active") {
        throw new Error(`Lease is not active: ${leaseId}`);
      }
      this.appendEvent({
        seq: this.nextSeq(),
        at: now(),
        kind: "turn_failed",
        leaseId,
        messageId: leaseRuntime.lease.messageId,
        nodeId: leaseRuntime.lease.nodeId,
        reason,
      });
    });
  }

  submitRaw(
    leaseId: string,
    responsePath: string,
  ):
    | { accepted: true; attemptId: string; proposal: ProposedTransition }
    | { accepted: false; attemptId: string; error: string } {
    const raw = readFileSync(responsePath, "utf8");
    const attemptId = randomUUID();
    let proposal: ProposedTransition | null = null;
    let parseError: string | null = null;
    try {
      proposal = parseProposedTransition(
        parseJsonText(raw, `worker response for lease ${leaseId}`),
      );
    } catch (error: unknown) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    return this.withLock(() => {
      const view = this.loadView();
      assertInitialized(view);
      assertOpen(view);
      const lease = view.leases.get(leaseId);
      if (lease === undefined || lease.status !== "active") {
        throw new Error(`Lease is not active: ${leaseId}`);
      }
      let validationError = parseError;
      if (proposal !== null && validationError === null) {
        try {
          validateProposal(view, leaseId, proposal);
        } catch (error: unknown) {
          validationError = error instanceof Error ? error.message : String(error);
        }
      }
      const attemptPath = join(
        this.root,
        "turns",
        leaseId,
        "attempts",
        `${attemptId}.txt`,
      );
      writeTextAtomic(attemptPath, raw);
      this.appendEvent({
        seq: this.nextSeq(),
        at: now(),
        kind: "turn_attempted",
        attemptId,
        leaseId,
        responseHash: hashText(raw),
        accepted: validationError === null,
        error: validationError,
      });
      if (proposal === null || validationError !== null) {
        return {
          accepted: false,
          attemptId,
          error: validationError ?? "Worker response was rejected",
        };
      }
      this.commitLocked(view, leaseId, proposal);
      return { accepted: true, attemptId, proposal };
    });
  }

  rejectRaw(
    leaseId: string,
    responsePath: string,
    reason: string,
  ): { accepted: false; attemptId: string; error: string } {
    const raw = readFileSync(responsePath, "utf8");
    const attemptId = randomUUID();
    return this.withLock(() => {
      const view = this.loadView();
      assertInitialized(view);
      assertOpen(view);
      const lease = view.leases.get(leaseId);
      if (lease === undefined || lease.status !== "active") {
        throw new Error(`Lease is not active: ${leaseId}`);
      }
      const attemptPath = join(
        this.root,
        "turns",
        leaseId,
        "attempts",
        `${attemptId}.txt`,
      );
      writeTextAtomic(attemptPath, raw);
      this.appendEvent({
        seq: this.nextSeq(),
        at: now(),
        kind: "turn_attempted",
        attemptId,
        leaseId,
        responseHash: hashText(raw),
        accepted: false,
        error: reason,
      });
      return { accepted: false, attemptId, error: reason };
    });
  }

  complete(status: RunCompletion["status"], summary: JsonValue): RunCompletion {
    return this.withLock(() => {
      const view = this.loadView();
      assertInitialized(view);
      assertOpen(view);
      if (status === "completed") {
        const unfinished = [...view.messages.values()].filter(
          (message) => message.status === "queued" || message.status === "leased",
        );
        if (unfinished.length > 0) {
          throw new Error(
            `Cannot complete run with ${unfinished.length} unfinished message(s)`,
          );
        }
      }
      const completion: RunCompletion = { status, summary };
      this.appendEvent({
        seq: this.nextSeq(),
        at: now(),
        kind: "run_completed",
        completion,
      });
      return completion;
    });
  }

  inspect(): JsonValue {
    const view = this.loadView();
    const run = assertInitialized(view);
    return {
      run,
      completion: view.completion,
      nodes: [...view.nodes.values()].map((node) => ({
        id: node.definition.id,
        generation: node.generation,
        state: node.state,
      })),
      messages: [...view.messages.values()].map((message) => ({
        ...message.message,
        status: message.status,
      })),
      leases: [...view.leases.values()].map((lease) => ({
        ...lease.lease,
        status: lease.status,
      })),
      attempts: [...view.attempts.values()],
    } as unknown as JsonValue;
  }

  verify(): void {
    const view = this.loadView();
    const run = assertInitialized(view);
    if (hashJson(readJson(join(this.root, "run.json"))) !== hashJson(run as unknown as JsonValue)) {
      throw new Error("Run snapshot mismatch");
    }
    for (const node of view.nodes.values()) {
      const definitionPath = join(
        this.root,
        "nodes",
        node.definition.id,
        "definition.json",
      );
      const statePath = join(
        this.root,
        "nodes",
        node.definition.id,
        "state.json",
      );
      if (hashJson(readJson(definitionPath)) !== hashJson(node.definition as unknown as JsonValue)) {
        throw new Error(`Definition snapshot mismatch: ${node.definition.id}`);
      }
      const expectedState: JsonValue = {
        generation: node.generation,
        state: node.state,
      };
      if (hashJson(readJson(statePath)) !== hashJson(expectedState)) {
        throw new Error(`State snapshot mismatch: ${node.definition.id}`);
      }
    }
    for (const leaseRuntime of view.leases.values()) {
      const inputPath = join(
        this.root,
        "turns",
        leaseRuntime.lease.id,
        "input.json",
      );
      if (hashJson(readJson(inputPath)) !== leaseRuntime.inputHash) {
        throw new Error(`Turn input hash mismatch: ${leaseRuntime.lease.id}`);
      }
      if (leaseRuntime.status === "committed") {
        const outputPath = join(
          this.root,
          "turns",
          leaseRuntime.lease.id,
          "output.json",
        );
        const committed = this.events().find(
          (event) =>
            event.kind === "turn_committed" &&
            event.leaseId === leaseRuntime.lease.id,
        );
        if (committed === undefined || committed.kind !== "turn_committed") {
          throw new Error(`Missing commit event: ${leaseRuntime.lease.id}`);
        }
        if (hashJson(readJson(outputPath)) !== committed.outputHash) {
          throw new Error(`Turn output hash mismatch: ${leaseRuntime.lease.id}`);
        }
      }
    }
    for (const attempt of view.attempts.values()) {
      const attemptPath = join(
        this.root,
        "turns",
        attempt.leaseId,
        "attempts",
        `${attempt.id}.txt`,
      );
      if (hashText(readFileSync(attemptPath, "utf8")) !== attempt.responseHash) {
        throw new Error(`Turn attempt hash mismatch: ${attempt.id}`);
      }
    }
  }

  rebuildSnapshots(): void {
    this.withLock(() => {
      const view = this.loadView();
      assertInitialized(view);
      for (const node of view.nodes.values()) {
        writeJsonAtomic(
          join(this.root, "nodes", node.definition.id, "definition.json"),
          node.definition as unknown as JsonValue,
        );
        this.writeNodeSnapshot(node.definition.id, node.generation, node.state);
      }
    });
  }

  loadView(): RunView {
    return reduceEvents(this.events());
  }

  events(): Event[] {
    if (!existsSync(this.eventPath())) {
      return [];
    }
    const text = readFileSync(this.eventPath(), "utf8").trim();
    if (text.length === 0) {
      return [];
    }
    return text.split("\n").map((line, index) =>
      parseEvent(parseJsonText(line, `events.jsonl line ${index + 1}`)),
    );
  }

  private appendEvent(event: Event): void {
    appendFileSync(
      this.eventPath(),
      `${canonicalStringify(event as unknown as JsonValue)}\n`,
      "utf8",
    );
  }

  private commitLocked(
    view: RunView,
    leaseId: string,
    proposal: ProposedTransition,
  ): ProposedTransition {
    const { leaseRuntime, node } = validateProposal(view, leaseId, proposal);
    const { lease } = leaseRuntime;
    const incoming = view.messages.get(lease.messageId);
    if (incoming === undefined) {
      throw new Error(`Lease references missing message: ${lease.messageId}`);
    }
    const messages: Message[] = proposal.outgoing.map((outgoing) => ({
      id: randomUUID(),
      requestId: incoming.message.requestId,
      callerId: node.definition.id,
      to: outgoing.to,
      body: outgoing.body,
      causationId: lease.messageId,
    }));
    const outputJson = proposal as unknown as JsonValue;
    const outputHash = hashJson(outputJson);
    writeJsonAtomic(join(this.root, "turns", leaseId, "output.json"), outputJson);
    this.appendEvent({
      seq: this.nextSeq(),
      at: now(),
      kind: "turn_committed",
      leaseId,
      messageId: lease.messageId,
      nodeId: lease.nodeId,
      previousGeneration: lease.expectedGeneration,
      nextState: proposal.nextState,
      outgoing: messages,
      result: proposal.result,
      inputHash: leaseRuntime.inputHash,
      outputHash,
    });
    this.writeNodeSnapshot(
      node.definition.id,
      node.generation + 1,
      proposal.nextState,
    );
    return proposal;
  }

  private eventPath(): string {
    return join(this.root, "events.jsonl");
  }

  private nextSeq(): number {
    return this.events().length;
  }

  private writeNodeSnapshot(
    nodeId: string,
    generation: number,
    state: JsonValue,
  ): void {
    writeJsonAtomic(join(this.root, "nodes", nodeId, "state.json"), {
      generation,
      state,
    });
  }

  private withLock<T>(operation: () => T): T {
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, ".scheduler.lock");
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx");
    } catch {
      throw new Error(`Scheduler lock is already held: ${path}`);
    }
    try {
      return operation();
    } finally {
      closeSync(descriptor);
      rmSync(path);
    }
  }
}

export function reduceEvents(events: readonly Event[]): RunView {
  const view: RunView = {
    run: null,
    nodes: new Map(),
    messages: new Map(),
    leases: new Map(),
    attempts: new Map(),
    completion: null,
  };
  let expectedSeq = 0;
  for (const event of events) {
    if (event.seq !== expectedSeq) {
      throw new Error(`Expected event sequence ${expectedSeq}, received ${event.seq}`);
    }
    expectedSeq += 1;
    switch (event.kind) {
      case "run_created":
        if (view.run !== null) {
          throw new Error("Run has multiple run_created events");
        }
        view.run = event.run;
        break;
      case "node_added":
        if (view.nodes.has(event.node.id)) {
          throw new Error(`Duplicate node event: ${event.node.id}`);
        }
        view.nodes.set(event.node.id, {
          definition: event.node,
          generation: 0,
          state: event.node.initialState,
        });
        break;
      case "message_queued":
        addMessage(view, event.message);
        break;
      case "turn_leased": {
        const message = view.messages.get(event.lease.messageId);
        if (message === undefined || message.status !== "queued") {
          throw new Error(`Cannot lease message: ${event.lease.messageId}`);
        }
        message.status = "leased";
        view.leases.set(event.lease.id, {
          lease: event.lease,
          status: "active",
          inputHash: event.inputHash,
        });
        break;
      }
      case "turn_attempted": {
        const lease = view.leases.get(event.leaseId);
        if (lease === undefined || lease.status !== "active") {
          throw new Error(`Invalid attempt event for lease: ${event.leaseId}`);
        }
        if (view.attempts.has(event.attemptId)) {
          throw new Error(`Duplicate attempt: ${event.attemptId}`);
        }
        view.attempts.set(event.attemptId, {
          id: event.attemptId,
          leaseId: event.leaseId,
          responseHash: event.responseHash,
          accepted: event.accepted,
          error: event.error,
        });
        break;
      }
      case "turn_committed": {
        const lease = view.leases.get(event.leaseId);
        const message = view.messages.get(event.messageId);
        const node = view.nodes.get(event.nodeId);
        if (
          lease === undefined ||
          lease.status !== "active" ||
          message === undefined ||
          message.status !== "leased" ||
          node === undefined
        ) {
          throw new Error(`Invalid commit event for lease: ${event.leaseId}`);
        }
        if (node.generation !== event.previousGeneration) {
          throw new Error(`Commit generation mismatch for node: ${event.nodeId}`);
        }
        lease.status = "committed";
        message.status = "done";
        node.generation += 1;
        node.state = event.nextState;
        for (const outgoing of event.outgoing) {
          addMessage(view, outgoing);
        }
        break;
      }
      case "turn_failed": {
        const lease = view.leases.get(event.leaseId);
        const message = view.messages.get(event.messageId);
        if (
          lease === undefined ||
          lease.status !== "active" ||
          message === undefined ||
          message.status !== "leased"
        ) {
          throw new Error(`Invalid failure event for lease: ${event.leaseId}`);
        }
        lease.status = "failed";
        message.status = "failed";
        break;
      }
      case "run_completed":
        if (view.completion !== null) {
          throw new Error("Run has multiple completion events");
        }
        view.completion = event.completion;
        break;
    }
  }
  return view;
}

function addMessage(view: RunView, message: Message): void {
  if (view.messages.has(message.id)) {
    throw new Error(`Duplicate message: ${message.id}`);
  }
  if (!view.nodes.has(message.to)) {
    throw new Error(`Message targets unknown node: ${message.to}`);
  }
  view.messages.set(message.id, { message, status: "queued" });
}

function validateProposal(
  view: RunView,
  leaseId: string,
  proposal: ProposedTransition,
): { leaseRuntime: LeaseRuntime; node: NodeRuntime } {
  const leaseRuntime = view.leases.get(leaseId);
  if (leaseRuntime === undefined || leaseRuntime.status !== "active") {
    throw new Error(`Lease is not active: ${leaseId}`);
  }
  const { lease } = leaseRuntime;
  const node = view.nodes.get(lease.nodeId);
  if (node === undefined) {
    throw new Error(`Lease references missing node: ${lease.nodeId}`);
  }
  if (node.generation !== lease.expectedGeneration) {
    throw new Error(
      `Stale lease ${leaseId}: expected generation ${lease.expectedGeneration}, current ${node.generation}`,
    );
  }
  for (const outgoing of proposal.outgoing) {
    if (!view.nodes.has(outgoing.to)) {
      throw new Error(`Proposal targets unknown node: ${outgoing.to}`);
    }
  }
  return { leaseRuntime, node };
}

function makeEnvelope(
  run: RunDefinition,
  lease: Lease,
  node: RunView["nodes"] extends Map<string, infer Runtime> ? Runtime : never,
  incoming: Message,
): WorkerEnvelope {
  return {
    protocolVersion: run.protocolVersion,
    runId: run.id,
    leaseId: lease.id,
    worker: run.worker,
    node: {
      id: node.definition.id,
      generation: node.generation,
      systemPrompt: node.definition.systemPrompt,
      corpus: node.definition.corpus,
      state: node.state,
    },
    incoming,
    outputContract: {
      nextState: "json",
      outgoing: "array<{to:string,body:json}>",
      result: "json",
    },
  };
}

function assertInitialized(view: RunView): RunDefinition {
  if (view.run === null) {
    throw new Error("Run is not initialized");
  }
  return view.run;
}

function assertOpen(view: RunView): void {
  if (view.completion !== null) {
    throw new Error(`Run is already ${view.completion.status}`);
  }
}

function writeJsonAtomic(path: string, value: JsonValue): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${canonicalStringify(value)}\n`, "utf8");
  renameSync(temporary, path);
}

function writeTextAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, "utf8");
  renameSync(temporary, path);
}

function now(): string {
  return new Date().toISOString();
}
