# Peer-routing memory: one label, one next hop

## Observation

`route-05` has an ideal two-hop path: `civic-procurement -> bio-soils ->
bio-pollinators`.  With the eight-word prompt, procurement instead started at
`civic-incidents`; it made 13 peer calls, hit 5 cycles, and returned a normal
HTTP 200 containing a negative answer.  The retry run eventually found
`Mallow-47`, but needed 18 calls and 8 cycles.  The guided run chose the ideal
branch first and received `Mallow-47` after its second forward, then continued
to 32 calls and 14 cycles.  A peer reply therefore needs an explicit result,
and a learned route needs to outrank unguided exploration.

## State

Each node owns a small plain-text table.  A row has exactly:

```
<question-kind> -> <direct-peer-id>
```

`question-kind` is a stable, short label supplied by the experiment fixture
(for example, `alder-batch-nesting-inserts`), not an embedding, score, count,
or answer cache.  Keep at most one row for a kind at a node.  Rows name only a
direct neighbor, never a complete route or a final answer.

For the confirmed route-05 chain, the durable rows are:

```
civic-procurement: alder-batch-nesting-inserts -> bio-soils
bio-soils: alder-batch-nesting-inserts -> bio-pollinators
```

The public `POST /ask` body remains the raw question.  Internally, a peer
reply must be classified as `FOUND <text>` or `NOT_FOUND`; HTTP 200 alone is
not evidence of either.  This is a result label, not a transition envelope.

## Exact update and selection rule

1. On a request with kind `K`, a node with `K -> P` asks `P` first.  A
   `FOUND` reply is returned immediately.  A `NOT_FOUND`, timeout, or cycle
   rejection deletes that row and leaves the node cold for this request.
2. A cold node may use its existing peer descriptions to choose peers.  It
   asks one direct peer at a time and stops at the first `FOUND`; it returns
   `NOT_FOUND` only after its permitted cold search is exhausted.
3. When a `FOUND` propagates back, every caller on that successful causal
   chain writes (or replaces) exactly its own `K -> immediate-next-peer` row.
   Calls made after the first `FOUND`, concurrent branches, `NOT_FOUND`, and
   cycle-rejected calls write nothing.

Replacement rather than scoring makes a later confirmed success sufficient to
repair a stale row.  Deletion on a failed warm hop prevents repeatedly routing
to a broken neighbor.

## Cold/warm experiment

Run each question kind twice with identical topology, private corpora, model,
and a one-active-outbound-call-per-node/request host limit.

- **Cold:** begin with no row for the kind at any node.  Record the first
  causal chain that returns `FOUND`; apply the update rule after it completes.
- **Warm:** rerun the same kind from the same origin with the cold-run rows
  retained.  No answer text, visited set, caller ID, cache, or extra routing
  prompt is retained.  The warm run must use the stored row at every matching
  node.

For route-05, a successful cold run should create the two rows above.  The
warm route is falsifiably predicted to be exactly
`civic-procurement -> bio-soils -> bio-pollinators`, with two peer calls, zero
cycle rejections, and no post-`FOUND` calls.

## Falsifiable hypotheses and metrics

1. **Route reuse:** for recurring kinds, warm exact-route rate is higher than
   cold exact-route rate.  Measure the fraction of successful runs whose
   `request_started` sequence equals the first confirmed chain.
2. **Search reduction:** warm peer calls, model turns, rejected cycles, and
   end-to-end duration are lower than cold.  Report medians and per-request
   deltas; do not infer improvement from one stochastic trial.
3. **No false learning:** no row is written after `NOT_FOUND`, timeout, cycle
   rejection, or a branch that was not the first `FOUND`.  Verify directly
   from the trace plus a memory-write log.
4. **Self-repair:** after a stored peer returns `NOT_FOUND`, its row is absent
   before the next request; a later `FOUND` writes its replacement.  Measure
   stale-row invalidations and successful replacements.

Success requires correct final-answer rate not to decrease while warm median
peer calls and rejected cycles fall.  If warm runs still explore after their
first `FOUND`, the failure is in stop/serialization, not in routing memory.
