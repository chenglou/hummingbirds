# Conclusions

The minimal request/reply lifecycle works with fresh disposable workers and
explicit node state.

## Observed runs

| Runs | Prompt | Result |
| --- | --- | --- |
| v1–v3 | Revision 1 | 1 pass, 2 failures |
| v4–v5 | Revision 2 | 2 passes |

All five runs found the private fact, used the route `a → b → c → b → a`, and
cleared pending state. The two revision-1 failures returned the right answer but
omitted `threadId` from A's human-facing result. Revision 2 changed one thing:
it gave the exact final-result shape `{ status: "final", threadId, answer }`.
Both fresh repeats then passed the full validator.

## Structure worth keeping

- Message bodies have `threadId`, `kind`, and question or answer content.
- A forwarding node stores `pending[threadId] = { caller, question }`.
- An answer follows the saved caller backward, then deletes that pending entry.
- A null caller means the answer is returned to the human through `result`.
- Each node has a local peer list and private corpus; no global directory is
  exposed.

This is enough for one unbranched question. It does not yet test simultaneous
threads, several replies, discovery, learned routing, quality judgments,
internet fallback, timeouts, or unknown propagation.

