# Transitive referral learning

This experiment asks whether contributor attribution lets a caller learn about
a useful node absent from its initial contacts, using one model-owned file for
both bootstrap contacts and learned routing.

Each node has only:

- `knowledge.md`: its private corpus;
- `nodes.md`: callable node IDs plus free-form experience.

A fresh origin begins with:

```text
# Known nodes

- B — known, but no experience yet.
```

B similarly begins knowing C and one distractor without knowing what either
does. Only C holds two different facts from the same invented subject. Every
node arrival uses a fresh model thread; only its two files persist.

The host resolves IDs already present in the caller's `nodes.md`, relays raw
text, rejects cycles, and records the trace. It never selects a route, inserts
an attribution, edits node memory, or scores a reply.

The treatment prompt requires useful contributor IDs to travel with an answer.
The control removes only that paragraph.

```sh
bun experiments/13-transitive-referral/run.ts \
  runs/13-transitive-referral-unified-luna gpt-5.6-luna
```

## Result

The clean Luna-low run is
[`runs/13-transitive-referral-unified-luna-v1`](../../runs/13-transitive-referral-unified-luna-v1).
Both arms answered both questions correctly, preserved the raw question, used
fresh threads, and kept answer phrases out of node memory.

In the attribution arm, A began knowing only B. After the first answer it kept B
and added C as a separate entry, noting that C contributed through B. In the
no-attribution arm, A learned only about B. Mandatory attribution therefore
caused real transitive node discovery using the single agent-owned file.

Collapsing `peers.md` and `routing.md` did not change the second route. Treatment
A still called its directly proven contact B, which called C; the control did the
same. Attribution creates a callable candidate, but the caller's local judgment
still ranks a directly observed successful node above a node vouched for by it.

The model appended new observations instead of replacing the initial “no
experience yet” line. That harmless redundancy is retained as evidence. A
deduplication instruction is not justified until accumulation becomes a real
problem.

## Isolation correction

An earlier split-file run placed node folders beside one another. A no-answer
node searched its parent and found another node's private corpus. The current
runner gives every node an unrelated opaque workspace and copies its files into
the run artifact only after execution. This is experimental isolation, not
agent routing logic.
