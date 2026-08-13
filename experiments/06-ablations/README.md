# Experiment 06: removing scaffolding

This pass asks which pieces of the 48-node experiment can disappear without
losing correct answers, exact question relay, or bounded routing.

## Results

### Warm learned routing

The smallest fully promoted candidate uses:

- the 18-word universal behavior prompt;
- private facts and peer HTTP addresses;
- hard local `kind -> successful peer` memory;
- no node or peer profiles;
- no model-visible memory prose;
- no advertisements, directory, cache, transition envelope, caller id, pending
  state, or one-outbound-call clamp.

At lookup time, the kind is not read from fixture metadata. Each node matches
the selected raw request text against only the kinds in its own memory.
Matching requires every normalized kind word and fails closed. Across 24
questions x 48 nodes this produces 150 applicable matches, 594 clean
non-matches, 408 nodes with no memory, and zero wrong matches.

The 54-row table was learned from the slim cold suite below, then tested on all
24 unseen B questions. Result: **24/24**, all 24 preserving the exact question
across hops, **54 calls**, zero cycles, mean **21,875 ms**, median **19,168
ms**, p90 **37,069 ms**. Artifacts are
`runs/06-ablate-retrained-warm-luna-scale-???-b` and
`routing-memory-from-ablated-cold.json`.

For comparison, the earlier 50-row table learned from the less ablated cold
baseline also scored 24/24 in 50 calls. The four-call difference is useful:
the current learner faithfully remembers a successful cold detour, even when
it is longer than necessary. Success-only memory is enough for correctness,
but not route optimization.

The mode is named `selected-text`, not `raw`: selection is precomputed from the
chosen request text before HTTP starts. The current runner still handles only
one selected question at a time; arbitrary concurrent request bodies need
per-request peer selection.

One remaining fixture dependency is explicit: the learning script currently
names each route kind from the experiment's `routingKind` label. Lookup is
question-text-driven, but discovering or naming new kinds is not learned yet.

### Cold discovery

Full descriptive profiles are unnecessary, but some compact identity is not.
The fully promoted candidate uses:

- the same 18-word behavior prompt;
- private facts and peer HTTP addresses;
- each node's exact `topic + role` label;
- model-visible one-hop topic advertisements;
- the local exact-topic directory;
- no memory prose or one-outbound-call clamp.

Result: **24/24**, all 24 preserving the exact question, **65 calls**, eight
rejected cycles, mean **20,411 ms**, median **17,023 ms**, p90 **33,513 ms**.
One question made 17 calls; the other 23 together made 48. Artifacts are
`runs/06-ablate-cold-topic-role-no-clamp-luna-scale-???-a`.

The generous call budget did what it was meant to do: the outlier recovered
instead of being cut off. Its detour then became a valid but longer learned
route. Route cost should therefore improve memory later; a small hard budget
is not required for correctness.

Visible advertisements are optional for correctness in the eight-topic screen:
removing their prose still scored 8/8, but calls rose from 18 to 32. The hard
directory continued to use the same one-hop labels internally. Keep visible
advertisements when efficiency matters; omit them when minimizing model-visible
text matters more.

## What failed or degraded

- Zero custom prompt: 7/8 on the cold screen, and the same miss failed on a
  Luna retry and Terra diagnostic. The prompt also protects raw relay and
  answer fidelity on longer chains.
- No cold profiles: 4/8 and 30 calls. A node could see reachable topics but not
  identify a matching direct holder.
- Topic-only cold profiles: 23/24; the remaining question failed twice on Luna
  and once on Terra. Adding the role fixed it.
- Advisory learned memory: one Luna run produced at least 117 peer calls and
  110 cycle rejections before the bounded screen was stopped. Hard next-hop
  selection is core.
- No cold directory: the bounded partial screen remained correct but wandered;
  two cases took 11 and 17 calls, with the latter taking about 93 seconds.
- No prompt, profiles, or call clamp: one question eventually answered after
  51 peer calls and 20 rejected cycles. Correctness alone is not a useful
  success criterion.

An answer-boundary bug was also found: `Amber Harbor-4672` used to count as
`Amber Harbor-467`. Matching now requires a complete normalized phrase and has
regression tests. Rechecking both prior 24-question baseline suites found no
false positives.

## Next experiment

Keep the prompt and transport fixed. Let a node replace a remembered route when
another successful route uses fewer hops, then remove the fixture-provided kind
label by learning a short local description from the question itself. Finally,
move kind selection from the runner's chosen question to each incoming HTTP
body so unrelated requests can be handled concurrently.

## Reproduce

Cold candidate:

```sh
bun experiments/04-raw-http/run.ts \
  runs/06-cold-example-scale-001-a \
  experiments/04-raw-http/prompt-answer-or-forward.md \
  scale-001-a all gpt-5.6-luna scale48x2 \
  experiments/05-scale-memory/routing-memory-empty.json \
  many advisory advertise directory topic-role hide selected-text
```

Warm candidate:

```sh
bun experiments/05-scale-memory/aggregate-success-memory.ts \
  experiments/06-ablations/routing-memory-from-ablated-cold.json \
  runs/06-ablate-cold-topic-role-no-clamp-luna-scale-???-a

bun experiments/04-raw-http/run.ts \
  runs/06-warm-example-scale-001-b \
  experiments/04-raw-http/prompt-answer-or-forward.md \
  scale-001-b all gpt-5.6-luna scale48x2 \
  experiments/06-ablations/routing-memory-from-ablated-cold.json \
  many hard quiet open none hide selected-text
```

Summarize a suite while checking that its configurations are comparable and
its request ids are unique:

```sh
bun experiments/06-ablations/summarize.ts \
  runs/06-ablate-retrained-warm-luna-scale-???-b/summary.json
```
