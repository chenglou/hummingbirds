# Meta-structure

## Stable boundary

The harness treats a model call as a proposed pure transition:

```text
(node definition, node state, one incoming message)
                         ↓
                    fresh worker
                         ↓
(next node state, zero or more outgoing messages, result)
```

Only the scheduler commits the lower tuple. This gives us:

- many logical nodes with only a few concurrent workers;
- explicit memory instead of hidden conversation history;
- causal traces for long and branching relays;
- a replaceable worker backend;
- replay of committed state without rerunning models.

## Source of truth

`events.jsonl` is append-only and authoritative. Snapshots under `nodes/` and
turn envelopes under `turns/` are materialized views. `rebuild` recreates node
snapshots from the event stream, while `verify` checks snapshot and artifact
hashes against it.

Each run also snapshots the disposable-worker instructions and execution
settings into `run.json` and every input envelope. Raw responses are retained,
including malformed ones, so prompt variants can be compared on reliability as
well as successful behavior. A final `run_completed` event distinguishes a
finished experiment from an empty queue, failure, or manual stop.

Model output itself is not expected to be deterministic. Reproducibility means
we can recover the exact input envelope, recorded proposal, committed messages,
and final state. Deterministic mock workers should additionally reproduce the
same output bytes.

## Intentionally absent

- routing or trust algorithms;
- a node-role taxonomy;
- model selection policy;
- hostile-node defenses;
- distributed scheduling;
- production-grade crash recovery.

Those would make it harder to tell whether a later result comes from the
network design or from the harness.
