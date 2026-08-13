# Agent-owned routing

This experiment gives every logical node three ordinary local files:

- `knowledge.md`: that node's private facts for the current question;
- `peers.md`: every direct peer and its address;
- `routing.md`: free-form, durable notes written and interpreted by the agent.

The host delivers the raw question, validates that `ask_peer` targets a direct
peer, rejects cycles, and records the trace. It does not classify questions,
score peers, read routing notes to choose a peer, or hide/reorder peers.

Cold discovery may include a static one-hop advertisement in `peers.md`. Warm
runs remove those advertisements. A warm run copies all node folders from its
cold run, replaces only `knowledge.md` with the unseen question's private fact,
and starts fresh ephemeral model threads. Thus only filesystem bytes persist.

## Prompt

The shared prompt is 55 words. It gives an order of operations and a place to
remember experience, but no routing schema, category list, score, or update
equation. See [`prompt.md`](prompt.md).

## Run

```sh
# Discover a route and let the nodes remember it.
bun experiments/07-agent-owned-routing/run.ts \
  runs/07-example-a scale-001-a clean gpt-5.6-terra \
  experiments/07-agent-owned-routing/prompt.md advertise

# Ask the unseen paired question using copied routing notes but plain peer lists.
bun experiments/07-agent-owned-routing/run.ts \
  runs/07-example-b scale-001-b runs/07-example-a/nodes gpt-5.6-terra \
  experiments/07-agent-owned-routing/prompt.md plain
```

Each run is a disposable copy. Passing `clean` makes empty routing files;
passing a prior `nodes` folder makes a new checkpoint without mutating it.

## Results so far

Two independent A/B transfers worked:

| Pair | Cold A | Unseen B with copied notes | Route |
| --- | --- | --- | --- |
| `scale-001` (astral) | correct, 2 calls, 0 cycles | correct, 2 calls, 0 cycles | geology → health → astral |
| `scale-010` (heritage) | correct, 2 calls, 0 cycles | correct, 2 calls, 0 cycles | ecology → civic → heritage |

A Luna-low check on `scale-024` also transferred, but less cleanly: cold A
found a 9-call route with 3 rejected cycles, while unseen B replayed the learned
route in 6 calls with no cycles. This is useful evidence that free-form memory
can retain a non-optimal route and improve repeat behavior; Terra was much more
efficient on the two clean checks.

For `scale-001-b`, the clean control used 49 peer calls in the coherent trace
snapshot and timed out after five minutes. Its first hop differed from the
learned run. In the learned run, each fresh thread read its inherited note
before choosing the peer named in it. Cold nodes wrote their notes only after a
successful downstream reply and before their final reply. No answer token was
stored in routing notes, and the unseen B token was absent from the A folders.

`scale-019-a` (the `archive` topic) timed out after broad exploration. The word
`archive` is also a node role, so the model followed many lexical distractors.
That failure is retained as useful evidence rather than patched with host-side
routing logic.

## Limitations

- This is two positive transfers, not a statistical result.
- The current sandbox confines writes and disables model shell networking, but
  does not cryptographically confine reads. Successful runs were audited and
  used only their own folders; strict private-corpus isolation still needs a
  stronger read sandbox.
- Timeout summaries can miss late in-flight trace events. For timed-out runs,
  use `trace.jsonl` as the coherent snapshot and treat teardown errors as such.
- Notes currently append redundant wording. Compression/deduplication is a
  later ablation, not part of this minimal test.

The next useful experiment is a larger sample of paired routes, including
failures, before adding scores, embeddings, schemas, or trust machinery.
