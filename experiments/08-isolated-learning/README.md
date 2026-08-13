# Isolated learnable routing

This removes relay behavior from the experiment. One router gets a fresh model
thread for every question, four opaque peer IDs, and one durable free-form
`routing.md`. Peers are deterministic endpoints that return either ordinary
answer text or ordinary `NOT_FOUND` text. They do not chain.

The host implements those endpoints and records which one the model chose. It
does not rank peers, label their specialties, interpret `routing.md`, or tell
the model whether a reply is good. First-hop choice is the main result.

## Default prompt

[`prompt.md`](prompt.md) is the single 71-word behavior prompt. Its important
postcondition is deliberately semantic rather than structural:

> If a peer clearly helped or failed, remember which peer and a general
> description of the relevant subject, never the answer.

There is no table schema, score, equation, embedding, or separate judge prompt.

## Exploration

The disposable runner trains one plant-physiology route and one harmony route,
then gives fresh threads:

- exact repeats;
- paraphrased, nearby questions;
- farther questions in the same subject;
- an unseen ceramics question;
- blank-file controls;
- counterfactual copies with the two learned peer IDs swapped.

All answer phrases are invented and differ across questions.

```sh
bun experiments/08-isolated-learning/run.ts \
  runs/08-isolated-luna gpt-5.6-luna \
  experiments/08-isolated-learning/prompt.md
```

## What happened

The first, vaguer 63-word prompt said only to write “general routing lessons.”
The model mostly learned “search everybody”: learned novel first-hop accuracy
was 25%, versus 0% blank.

The current prompt added only “which peer and a general description of the
subject.” With the same header-only file and Luna-low:

- exact-repeat first-hop accuracy: 2/2;
- unseen near/far first-hop accuracy: 4/4, versus 0/4 blank;
- average learned calls: 1.86, versus 4.0 blank (including one unseen subject);
- answer tokens stored in routing notes: 0;
- memorization gap: 0;
- swapping the two peer IDs in the file swapped both near-question first hops.

The learned file was ordinary prose:

```text
# Routing notes
- node-17: useful for fictional plant-physiology notebook access-phrase queries.
- node-42: useful for fictional harmony workbook deceptive-cadence exercise access-phrase queries.
```

It also retained some observed negative results. On the unseen ceramics query,
the learned router explored all four peers and discovered `node-68`, rather than
pretending an existing specialty applied.

One far probe appended “Please answer concisely” to the relayed question. It
still chose the correct peer first, but the original deterministic endpoint was
needlessly coupled to exact wording and returned `NOT_FOUND`. The runner now
keeps preservation as a separate metric and lets the selected owner answer;
this experiment is about routing, not transport fidelity.

## Conclusion

The smallest useful default found here is not a trust number. It is one local,
free-form observation containing:

1. the peer;
2. whether it helped or failed;
3. the general subject of the request.

That was enough for semantic specialization and causal reuse after one example.
The next useful exploration is accumulation and repair: learn several subjects
in one file, move one specialty, and see whether later evidence replaces the
stale route. No new infrastructure is needed for that test.
