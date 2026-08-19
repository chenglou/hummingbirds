# Hummingbirds

A small prototype of questions moving through a network of AI nodes. Every bird is an independent Bun process with its own port and one continuing Codex session. The model—not the harness—chooses whom to ask, what to remember, and how its routing changes.

## Run it

```sh
bun install
codex login
bun run hummingbirds run example/scenario.json \
  "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for tideglass trial Nacre-A?"
```

The raw answer goes to stdout. The run directory and request ID go to stderr. Inspect the complete cross-node trace afterward:

```sh
bun run hummingbirds inspect runs/<run> <request-id>
```

Pass several quoted questions to `run` to ask them sequentially on the same live network. Each request launches a Codex CLI process that resumes that bird's exact session, so later questions retain earlier facts and routing experience in context. A bird handles only one model turn at a time; concurrent requests wait in its local queue.

Codex CLI authentication is reused; no API key is copied into a bird. Override the model or reasoning with `HUMMINGBIRDS_CODEX_MODEL` or `HUMMINGBIRDS_CODEX_REASONING_EFFORT`.

For agent-level debugging, set `HUMMINGBIRDS_CODEX_JSON_TRACE=1`. Each node then retains Codex's raw JSONL events, final message, and stderr under `codex-traces/`; `/ask` still returns only the final plain-text answer.

Prompt changes have an opt-in live slow-peer eval. It gives one Luna bird an in-memory peer with a fresh random answer, delays that answer past Codex's tool yield, and rejects duplicate or abandoned calls:

```sh
bun run eval:slow-peer --run-real-model \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex
```

This eval makes real model calls and is deliberately separate from `bun test`.

The abstract routing exploration runs without models or HTTP. It compares uniform, hard-choice, and success-weighted stochastic routing in matched worlds with and without useful topic structure:

```sh
bun run eval:routing
```

Nodes have bounded local peer and learned-fact memory. Answers are exact hidden tokens; successful return paths credit only immediate callees, while provider attribution lets callers discover untested peers. Seen and held-out probes separate answer caching from topic-level routing generalization. A query follows one non-repeating path, so it ends at an answer or dead end without an arbitrary hop limit. See the [methods and first results](evals/routing-simulation.md).

## The boundary

Each runtime node contains:

```text
server.ts
agent.ts
protocol.ts
prompt.md
AGENTS.md
events.jsonl
```

`server.ts` exposes only `POST /ask`: plain text in, plain text out. `agent.ts` starts or resumes the bird's full Codex session and records process-level events. The rendered `AGENTS.md` contains the shared prompt, that bird's ID and address, its initial peers, and its initial private knowledge.

There are no mutable routing or knowledge files. Later facts, peer evaluations, and discovered routes remain in the Codex conversation. The Bun server remembers the exact Codex thread ID for the lifetime of the running bird; restart-and-resume is deliberately deferred.

The harness only creates isolated folders, renders the initial context, starts processes on ephemeral ports, sends root questions, and reads append-only events. `network.json` and `events.jsonl` exist for inspection; neither is consulted when an agent routes. Codex is only the reference implementation behind `/ask`; another implementation can expose the same plain-text boundary.

The scenario supplies initial peer IDs and private seed text. For example, `a → b → c` lets `a` begin with one unknown contact while the invented answer starts only in `c`'s context:

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

There are no router/end-node roles, scores, answer schemas, caches, retries, or hop limits. Cycles are rejected when callers preserve the request path. Valid requests to one bird are processed serially.

The archived exploration that led here is available at Git tag `exploration-v1`.
