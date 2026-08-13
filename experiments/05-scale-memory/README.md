# Experiment 05: scale, local discovery, and routing memory

## Setup

[`graph.ts`](graph.ts) deterministically creates 48 nodes in eight topical
clusters and 24 routes. With `variantsPerRoute: 2`, each route gets an A
training question and an unseen B question. Their answers differ, while their
kind and route are shared. Only each answer holder receives its private fact.

All runs keep the raw HTTP design: one loopback port and one private model
thread per node, raw text in and out, and only `ask_peer`. There is no answer
cache or model-visible transport state.

## Results

- **Blind cold routing failed.** The first 48-node question failed with both
  Luna and Terra after long, wandering searches. Merely enlarging the graph
  made peer profiles too weak as a directory.
- **Advisory peer advertisements helped but were unreliable.** A peer could
  say which topics its own direct peers knew. Luna recovered 16 of 24 cold A
  questions; Terra recovered 2 of the eight Luna failures.
- **Explicit topic labels removed semantic guessing.** Each generated question
  names one of the eight topics, and node profiles use the same exact label.
  This alone did not fix the two difficult spot checks: advisory selection
  could still ignore the right peer.
- **Hard local directory routing was clean.** The runtime exposed only direct
  peers whose own or advertised topic exactly matched the named topic. The
  topic universe is strictly local: only direct peers' own labels and the
  labels they advertise from their direct neighbors are considered. It is not
  a global directory. Cold A scored **24/24**, with mean **19,951 ms**, median
  **17,227 ms**, p90 **32,671 ms**, and **50 peer calls**: 23 questions used
  two calls and one used four. The final local-only regression checks
  `scale-001-a` and `scale-019-a` both passed in two hops.
- **Successful A routes learned 50 kind-only rows.** The learned artifact has
  50 `{ kind, peerId, outcome: "answered" }` rows across 31 nodes and eight
  kinds. It contains no question or answer text.
- **Unseen B transfer was 24/24.** Hard selection from that learned memory,
  with advertisements and directory filtering disabled, scored **24/24**.
  Mean was **20,497 ms**, median **18,447 ms**, p90 **36,617 ms**, with the
  same **50 calls** and 23 two-call plus one four-call routes. This is routing
  transfer to different answers, not answer reuse.

The specialization analysis unions memory owners and trace participants, so
it reports 37 observed nodes; 31 actually own memory rows. Across those rows
there are eight kinds, and no node owns more than two. No intermediary appears
more than once. The current balanced fixture therefore shows local
specialization, but deliberately produces no hubs or hierarchy.

## Candidate MVP

The smallest version supported by these runs is:

1. Each node exposes `POST /ask` with a raw-text question and answer.
2. Each node has private facts, direct peer addresses, and exact topic labels.
3. Each direct peer may advertise only the labels reachable through its own
   direct peers.
4. An exact topic named in the question restricts routing to matching direct
   peers; otherwise all direct peers remain available.
5. After a correct answer, each caller stores only
   `question kind -> immediate successful peer`.
6. A known row is a hard next hop. Store no answers, full paths, caller IDs,
   pending state, or completed cache.

This keeps the external protocol minimal while making discovery and repeated
routing deterministic enough to test.

## Reproduce

Run the pure checks:

```sh
bun test experiments/05-scale-memory
```

One cold local-directory run (arguments after the model select the graph,
memory, one-call policy, hard-memory policy, advertisements, and directory):

```sh
bun experiments/04-raw-http/run.ts \
  runs/05-directory-example-scale-001-a \
  experiments/04-raw-http/prompt-answer-or-forward.md \
  scale-001-a all gpt-5.6-luna scale48x2 \
  experiments/05-scale-memory/routing-memory-empty.json \
  one advisory advertise directory
```

Aggregate successful A run directories into learned memory:

```sh
bun experiments/05-scale-memory/aggregate-success-memory.ts \
  experiments/05-scale-memory/routing-memory-learned-24.json \
  runs/05-directory-suite-luna-scale-???-a
```

Run an unseen B question using only hard learned memory:

```sh
bun experiments/04-raw-http/run.ts \
  runs/05-learned-example-scale-001-b \
  experiments/04-raw-http/prompt-answer-or-forward.md \
  scale-001-b all gpt-5.6-luna scale48x2 \
  experiments/05-scale-memory/routing-memory-learned-24.json \
  one hard
```

Inspect specialization from the artifact and any run summaries or directories:

```sh
bun experiments/05-scale-memory/analyze-specialization.ts \
  experiments/05-scale-memory/routing-memory-learned-24.json \
  runs/05-learned-warm-luna-scale-???-b/summary.json
```

The main learned artifact is
[`routing-memory-learned-24.json`](routing-memory-learned-24.json).
[`memory-design.md`](memory-design.md) records the update rule.

## Oracle upper bound

[`seed-upper-bound.ts`](seed-upper-bound.ts) derives ideal next hops directly
from the fixture. It is an explicitly seeded upper bound, not learned evidence,
and is kept separate from the result above. It also contains kinds and next
hops only—never answers.

```sh
bun experiments/05-scale-memory/seed-upper-bound.ts \
  experiments/05-scale-memory/routing-memory-scale48-oracle.json
```
