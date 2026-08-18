# Hummingbirds

A small prototype of questions moving through a network of AI nodes. Every node is an independent Bun process with its own port and folder. The model—not the harness—chooses whom to ask and what routing experience to retain.

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

Pass several quoted questions to `run` to ask them sequentially on the same live network. Later questions see the `nodes.md` learned from earlier ones.

Each request starts a fresh, ephemeral `codex exec` process. Codex CLI authentication is reused; no API key is copied into a bird. Override the model or reasoning with `HUMMINGBIRDS_CODEX_MODEL` or `HUMMINGBIRDS_CODEX_REASONING_EFFORT`.

For agent-level debugging, set `HUMMINGBIRDS_CODEX_JSON_TRACE=1`. Each node then retains Codex's raw JSONL events, final message, and stderr under `codex-traces/`; `/ask` still returns only the final plain-text answer.

## The boundary

Each runtime node contains:

```text
server.ts
agent.ts
protocol.ts
prompt.md
AGENTS.md
knowledge.md
nodes.md
events.jsonl
```

`server.ts` only exposes `POST /ask`: plain text in, plain text out. `agent.ts` starts a full Codex agent for each request and records process-level events. The rendered `AGENTS.md` is that bird's instruction prompt.

`knowledge.md` is its private corpus. `nodes.md` is its routing memory. The agent can read and update both, ask another bird over HTTP, use its other agent capabilities, and search the web. Answers remain plain text and carry useful contributor IDs and addresses so a caller can learn a transitive route.

The harness only copies folders, renders the shared prompt, starts processes on ephemeral ports, seeds initial acquaintances, sends the root question, and reads append-only events. `network.json` and `events.jsonl` exist for inspection; neither is consulted when an agent routes. Codex is only the reference implementation behind `/ask`; another implementation can expose the same plain-text boundary.

The scenario says only who initially knows whom. For example, `a → b → c` lets `a` begin with one unknown contact while the invented answer exists only in `c`'s corpus.

```json
{
  "entry": "a",
  "nodes": [
    { "id": "a", "knows": ["b"] },
    { "id": "b", "knows": ["c"] },
    { "id": "c", "knows": [] }
  ]
}
```

There are no router/end-node roles, scores, answer schemas, caches, retries, or hop limits. Cycles are rejected from the request path. Concurrent writes to one node's `nodes.md` are deliberately left for a later experiment.

The archived exploration that led here is available at Git tag `exploration-v1`.
