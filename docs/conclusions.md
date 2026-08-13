# Meta-structure conclusions

## What was tested

- A live five-node fork-and-join relay used six fresh model turns. Two branch
  workers ran in parallel; the shared join node processed its two messages in
  order and kept both updates.
- A deterministic relay handled 1,000 logical nodes and 1,000 turns in about
  11 seconds locally. Model latency will dominate normal experiments.
- Automated checks cover replay, per-node serialization, corpus isolation,
  artifact tampering, malformed and invalid worker replies, retries, and final
  run completion.

## Stable boundary

- Logical nodes are durable prompt, corpus, state, and message records.
- Model workers are disposable and receive one self-contained turn envelope.
- One scheduler commits all state changes and outgoing messages.
- Different nodes may run in parallel; one node's turns are serialized.
- An append-only event stream is authoritative. Snapshots can be rebuilt.
- Worker instructions and execution settings are frozen into each run.
- Raw worker replies are kept even when rejected.
- Finishing or stopping a run is explicit rather than inferred from an empty
  queue.

This makes the four-thread limit a throughput limit, not a node-count limit.
The primary agent can schedule three fresh workers repeatedly across any number
of logical nodes.

## Freeze decision

This is sufficient for exploring network structures. Do not expand the harness
unless an experiment exposes a distortion or missing observation.

Known acceptable limits:

- Model replies are not deterministic; replay preserves exact inputs, outputs,
  and state rather than promising the model will answer identically.
- Codex worker spawning is orchestrated by the primary agent, not by this CLI.
- The simple file lock has no production crash recovery.
- There are no lease timeouts or distributed schedulers.
- JSONL replay will eventually become slow, but 1,000-turn experiments are
  already cheap relative to model calls.

Routing, trust, specialization, verification, internet use, and the universal
node prompt remain intentionally outside the harness. They are the next layer
to iterate on.

