# Hummingbirds

A small prototype of stateful AI nodes communicating over one low-level boundary: plain-text `POST /ask` in, plain-text response out. Each bird owns one continuing Codex session. The model—not a JavaScript router—decides whom to ask, what to retain, and how its local view of the flock changes.

## Core

The deployable runtime is intentionally small in shape:

```text
src/
  server.ts            One bird's Bun server, queue, Codex session, and persistence
  prompt_template.md   Rendered into the bird workspace as AGENTS.md
```

`server.ts` is one process with one lifetime. It accepts `/ask`, rejects request-path cycles before queueing, serializes valid turns, starts or resumes Codex CLI, and atomically saves the resulting thread ID. These responsibilities used to be split among `server.ts`, `agent.ts`, and `protocol.ts`; there was only one caller and no interchangeable agent or protocol implementation, so the split added names and imports without representing independent components. A focused Codex adapter can be extracted later if a second model backend creates a real boundary.

The bird's mutable data is separate from the app source:

```text
bird/
  workspace/
    AGENTS.md
  thread-id
```

The actual transcript and compaction state remain in Codex's session store. Resuming therefore requires the same workspace, thread-ID path, and Codex home/profile. The bird has no routing or knowledge file; later facts, peer judgments, and discovered routes live in its conversation.

Diagnostics are optional. Set `HUMMINGBIRDS_EVENT_LOG_PATH` to append process and request events somewhere outside the model workspace. Also set `HUMMINGBIRDS_CODEX_JSON_TRACE=1` to retain raw Codex JSONL beside that event log. The repository's `logs/` directory is ignored and used only by experiments.

The current server binds to loopback and expects its workspace, rendered prompt, thread-ID path, and Codex profile to be provisioned by its caller. A stable hosted launcher, advertised public address, and authentication remain future deployment work.

## Local flock experiment

The multi-process local harness is an experiment rather than part of the deployed bird:

```sh
bun install
codex login
bun run experiment:local-flock run experiments/local-flock/scenario.json \
  "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for tideglass trial Nacre-A?"
```

The answer goes to stdout. The ignored run directory and request ID go to stderr. Inspect the cross-node event trace afterward:

```sh
bun run experiment:local-flock inspect logs/<run> <request-id>
```

Pass several quoted questions to `run` to ask them sequentially on the same live flock. Every node gets an unrelated temporary workspace containing a rendered `AGENTS.md`; all nodes execute the same immutable `src/server.ts` from the repository. The harness starts ephemeral ports, supplies initial peer addresses and private seed text, and writes diagnostics under one ignored run directory. On orderly shutdown it archives remaining workspace artifacts and removes the temporary roots.

For model-level debugging, override `HUMMINGBIRDS_CODEX_MODEL`, `HUMMINGBIRDS_CODEX_REASONING_EFFORT`, or `HUMMINGBIRDS_CODEX_REASONING_SUMMARY`.

Prompt changes have an opt-in slow-peer experiment. It gives one Luna bird an in-memory peer with a fresh random answer, delays that answer past Codex's tool yield, and rejects duplicate or abandoned calls:

```sh
bun run experiment:slow-peer --run-real-model \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex
```

This makes real model calls and is deliberately separate from `bun test`.

## Repository layout

```text
src/                          Single-bird runtime and prompt template
experiments/local-flock/      Temporary multi-bird harness, CLI, trace reader, scenario
experiments/slow-peer.ts      Opt-in live prompt regression experiment
experiments/*.md              Distilled findings and future ideas
tests/                        Deterministic runtime and harness verification
logs/                         Ignored, disposable diagnostic output
```

The [abstract routing exploration](experiments/routing-simulation.md) records results from the removed 10,000-node simulator. The [live routing exploration](experiments/live-routing.md) records broker hierarchy, conflict resolution, contextual self-answering, and route shortening observed with real stateful models. The archived implementation that preceded the current cleanup is available at Git tag `exploration-v1`.

## Network behavior

The local scenario supplies initial peer IDs and private seed text. For example, `a → b → c` lets `a` begin with one contact while the invented answer starts only in `c`'s context:

```json
{
  "entry": "a",
  "nodes": [
    { "id": "a", "peers": ["b"], "seed": "" },
    { "id": "b", "peers": ["c"], "seed": "" },
    { "id": "c", "peers": [], "seed": "A private fact." }
  ]
}
```

There are no router/end-node roles, scores, answer schemas, caches, retries, or hop limits. Cycles are rejected when callers preserve the request path. Valid requests to one bird are processed serially. Codex CLI is only the current implementation behind `/ask`; another bird may implement the same plain-text boundary differently.
