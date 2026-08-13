# Experiment 02: 24-node local routing

This graph has 24 persistent logical agents in four loose topic clusters:
astronomy, biosphere, civic systems, and heritage. It has 43 fixed, local,
two-way peer links. No node sees the whole graph.

Eight invented questions start concurrently. Each answer exists in exactly one
private corpus. Their ideal three-node routes cover the graph, while actual
routing is free to choose another local path. Disposable model workers time-share
the 24 identities.

Revision 1 was deliberately stopped after two malformed replies revealed that
the prompt needed exact JSON and pending-state shapes. Its trace is retained in
`runs/02-24-node-routing-v1`; revision 2 contains that one prompt correction.

Revision 2 completed seven of eight requests, then exposed a missing intended
graph edge and repeated omission of a message `kind` during fallback. Revision 3
adds that edge, states exact body shapes, and records semantic rejections inside
the verified harness trace.

Revision 3 was excluded after one turn because the coordinator improperly
rejected a valid unexpected route. Revision 4 uses the same graph and prompt;
routing quality or disagreement with an expected path is never a rejection
reason.

Revision 4 passed all eight questions. Its final observations are in
[`conclusions.md`](conclusions.md).

A later worker-pool benchmark ran the same graph with five external Luna-low
Fast workers. Its first two revisions were retained after exposing a root
finalization error and a concurrent-state JSON formatting error. Revision 3
passed all eight questions in 97.032 seconds of worker wall time. See the Luna
section in [`conclusions.md`](conclusions.md).

The experiment tests only:

- local semantic peer choice;
- recursive question and answer relaying;
- concurrent request separation;
- runtime-managed request and caller IDs;
- complete observable lineage and private-corpus isolation.

It does not test learned routing, changing peers, fan-out, verification, web
fallback, adversaries, or emergent topology.

Create a run:

```sh
bun experiments/02-24-node-routing/setup.ts runs/02-24-node-routing-v1 02-24-node-routing-v1
```

Pass a fourth argument to snapshot a different worker execution manifest, such
as the external Luna Fast pool:

```sh
bun experiments/02-24-node-routing/setup.ts \
  runs/02-24-node-routing-luna-fast-v3 \
  02-24-node-routing-luna-fast-v3 \
  examples/worker-execution-luna-fast.json

bun run codex-pool runs/02-24-node-routing-luna-fast-v3 5
```

After processing every lease with a fresh worker, validate it:

```sh
bun experiments/02-24-node-routing/validate.ts runs/02-24-node-routing-v1
```
