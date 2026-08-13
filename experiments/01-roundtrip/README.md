# Experiment 01: one question round trip

This isolates one lifecycle:

```text
human → a → b → c
human ← a ← b ← c
```

Only `c` knows the invented answer. `a` knows only `b`; `b` knows only `c`.
Every node uses the same short prompt. There is no discovery, scoring, branching,
verification, web access, or learned routing.

Success requires:

- the question reaches `c` without being answered or altered by `a` or `b`;
- `a` and `b` persist the caller while waiting;
- the answer returns through `b` and `a` with the same `threadId`;
- `a` emits a final answer containing `Kestrel Nine`;
- every node finishes with an empty `pending` object.

Validate a completed run with:

```sh
bun experiments/01-roundtrip/validate.ts runs/01-roundtrip-v1
```

Create another independent run with:

```sh
bun experiments/01-roundtrip/setup.ts runs/01-roundtrip-v2 01-roundtrip-v2
```

Results and the one prompt revision are recorded in
[`conclusions.md`](conclusions.md).
