# Repeated repair

This asks whether repeated evidence naturally turns a newly discovered peer into
the first choice, without changing the 71-word prompt or adding a routing
format.

After one old-owner success, the subject silently moves from `node-17` to
`node-68`. Four fresh router sessions then ask different questions in that same
subject while only `routing.md` carries forward. Each question also has an
independent reset control starting from the exact stale snapshot.

The main trace is first peer and number of calls per question. Full convergence
means the final two cumulative questions both call `node-68` first and answer in
one call; reset controls show whether that came from accumulated notes.

```sh
bun experiments/10-repeated-repair/run.ts \
  runs/10-repeated-repair-luna gpt-5.6-luna
```

## What happened

Two Luna-low runs showed partial but unstable repair:

- In the first run, cumulative routing chose `node-68` first once; the four
  stale controls always chose `node-17` first. It reverted to `node-17` on the
  following question, so it did not converge.
- In the second run, cumulative routing never chose `node-68` first, but after
  discovering it, every later answer took two calls (`node-17`, then
  `node-68`). Each stale control took four calls.

The free-form file accumulated correct evidence without storing answers, but
kept the original broad positive claim about `node-17`. Later negative notes
were phrased as failures on particular records, while positive `node-68` notes
also remained mostly example-specific. The fresh model sessions therefore did
not reliably infer that the whole subject had moved.

So repeated evidence gives a useful shortlist, but not reliable route
replacement. That is the first concrete reason to consider a tiny prompt change
later—for example, asking the node to revise stale generalizations rather than
only append observations. This experiment does not make that change.
