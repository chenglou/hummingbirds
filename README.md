# Agent network harness

A small prototype of questions moving through a network of AI nodes. Every node is an independent Bun process with its own port and folder. The model—not the harness—chooses whom to ask and what routing experience to retain.

## Run it

```sh
bun install
export OPENAI_API_KEY=...
bun run net run example/scenario.json \
  "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for tideglass trial Nacre-A?"
```

The raw answer goes to stdout. The run directory and request ID go to stderr. Inspect the complete cross-node trace afterward:

```sh
bun run net inspect runs/<run> <request-id>
```

Pass several quoted questions to `run` to ask them sequentially on the same live network. Later questions see the `nodes.md` learned from earlier ones.

The default is `gpt-5.6-luna` with low reasoning. Override it with `OPENAI_MODEL` or `OPENAI_REASONING_EFFORT`. `OPENAI_BASE_URL` can point at another Responses-compatible endpoint.

## The boundary

Each runtime node contains:

```text
server.ts
agent.ts
protocol.ts
prompt.md
knowledge.md
nodes.md
events.jsonl
```

`server.ts` only exposes `POST /ask`: plain text in, plain text out. `agent.ts` implements answering, forwarding, routing-memory updates, and trace recording.

`knowledge.md` is its private corpus. `nodes.md` is its only routing memory. A model may call two local capabilities: send a raw question to an address, or replace its own `nodes.md`. Web search is also available. Answers remain plain text and carry useful contributor IDs and addresses so a caller can learn a transitive route.

The harness only copies folders, starts processes on ephemeral ports, seeds initial acquaintances, sends the root question, and reads append-only events. `network.json` and `events.jsonl` exist for inspection; neither is consulted when an agent routes.

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
