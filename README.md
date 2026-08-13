# net

`net` is a small experiment harness for running many persistent logical AI nodes
through a much smaller pool of disposable model workers.

The boundary is deliberate:

- A **logical node** is its explicit prompt, corpus, state, and incoming messages.
- A **worker** is a fresh model invocation that proposes one state transition.
- The **scheduler** is the only writer. It validates and commits proposals.
- `events.jsonl` is the source of truth; node snapshots are rebuildable caches.

This folder holds the meta-structure only. Routing policy, trust, specialization,
verification, and other network designs belong in later experiments.

The tested boundary and freeze decision are in
[`docs/conclusions.md`](docs/conclusions.md).

The first network-structure experiment is
[`experiments/01-roundtrip`](experiments/01-roundtrip/README.md).

The 24-node local-routing experiment is
[`experiments/02-24-node-routing`](experiments/02-24-node-routing/README.md).

The resident-thread latency experiment is
[`experiments/03-resident-single-question`](experiments/03-resident-single-question/README.md).

The raw HTTP and tiny-prompt experiment is
[`experiments/04-raw-http`](experiments/04-raw-http/README.md).

The 48-node discovery and learned-routing experiment is
[`experiments/05-scale-memory`](experiments/05-scale-memory/README.md).

The prompt and routing ablations, including the slim cold-to-warm pipeline,
are in [`experiments/06-ablations`](experiments/06-ablations/README.md).

The agent-owned filesystem routing experiment, where agents interpret and
update their own free-form peer notes, is in
[`experiments/07-agent-owned-routing`](experiments/07-agent-owned-routing/README.md).

The smaller isolated experiment for semantic routing, specialization, and
caller-owned judgment is in
[`experiments/08-isolated-learning`](experiments/08-isolated-learning/README.md).

The separate stale-route repair experiment is in
[`experiments/09-route-repair`](experiments/09-route-repair/README.md).

The repeated-evidence follow-up, with stale-memory controls, is in
[`experiments/10-repeated-repair`](experiments/10-repeated-repair/README.md).

The raw-prose experiment for learning peer quality from delayed outcomes is in
[`experiments/11-freeform-quality`](experiments/11-freeform-quality/README.md).

The mixed peer/local-capability fallback experiment is in
[`experiments/12-capability-fallback`](experiments/12-capability-fallback/README.md).

The current general-purpose node system prompt is
[`prompts/node.md`](prompts/node.md). Its message envelope keeps both a
`requestId` and a `callerId`; protocol v3 preserves the former and sets the
latter to the immediate sender on every hop. Delivery `id` and `causationId`
remain separate so every hop has a complete lineage.

## Quick start

```sh
bun install
bun run check

bun run net init runs/example example-run prompts/worker.md examples/worker-execution.json
bun run net add-node runs/example examples/node-a.json
bun run net add-node runs/example examples/node-b.json
bun run net enqueue runs/example a examples/question.json
bun run net lease runs/example worker-1
```

`lease` prints a self-contained JSON envelope for a fresh worker. Save the raw
response and submit it. Malformed attempts remain in the trace; valid responses
are committed:

```sh
bun run net submit runs/example LEASE_ID response.txt
```

If a response is valid JSON but violates an experiment's semantic contract,
record it without committing state, then retry the same lease fresh:

```sh
bun run net reject runs/example LEASE_ID response.txt "missing answer kind"
```

When the intended experiment is over, record that explicitly:

```sh
bun run net complete runs/example completed examples/meta-blitz/summary.json
```

Use `inspect`, `verify`, and `rebuild` to understand or reproduce a run. The
older `commit` command remains useful for deterministic mock proposals.

## Run layout

```text
run/
  run.json
  events.jsonl
  nodes/<node-id>/
    definition.json
    state.json
  turns/<lease-id>/
    input.json
    output.json
    attempts/<attempt-id>.txt
```

Workers do not read this layout directly. The scheduler constructs the exact
input envelope, which prevents ambient files or an old worker conversation from
silently becoming node memory.

The run snapshots its disposable-worker instructions and execution settings,
so later comparisons retain the actual model, reasoning level, tools, and
wrapper used for every turn.
