# Live stateful-routing exploration

Quick model-backed explorations on 2026-08-19 used the shared prompt, one continuing
Codex session per bird, private invented manuals, and trace-derived routes. Temporary
fixtures were discarded; this records the observations that affect the design.

## Natural manual flock

Six Sol/high birds formed a small flock: entry A knew broker B; B knew a makerspace
manual holder C, a current dispatch-policy holder D, a stale pocket-card holder E, and a
document-control holder F. Six sequential questions mixed related facts, a D/E conflict,
and one calculation.

- All answers were correct and every unseen private fact arrived through a peer call.
- A kept B as its first hop for all five externally sourced questions. B behaved as a
  useful hub rather than A always flattening the graph.
- For the conflict, B queried D, E, and F concurrently. F established that D's revision
  superseded E's, so the flock returned D's two-hour deadline instead of voting or using
  E's stale four-hour answer.
- On the next policy question B used only D. On the final calculation A made no peer call:
  it correctly applied policy retained in its own conversation.
- No cross-node filesystem reads appeared in the traces. This run supports contextual
  learning, synthesis, and source reconciliation, but not direct-route promotion at A.

## Clean interleaved routing

A second Sol/high run put six birds in unrelated runtime roots. The seeded graph had two
branches: `A → B → C → E` for Orchid Press and `A → B → D → F` for Tideglass Regulator.
Only E and F held answers. Four questions alternated branches; the second question in
each topic asked for a different, previously unseen fact.

| Question | Observed route | Result | Root latency |
| --- | --- | --- | ---: |
| Orchid cold | `A → B → C → E` | correct | 45.7 s |
| Tideglass cold | `A → B → D → F` | correct | 39.5 s |
| Orchid warm | `A → C → E` | correct | 30.2 s |
| Tideglass warm | `A → F` | correct | 14.8 s |

All calls returned 200 with correct lineage, no failures, and no exact duplicates. Every
later turn resumed the same per-bird thread. The only commands were intended peer curls;
there were no web calls, connected-app calls, sibling reads, parent reads, or global
directory searches.

This validates that context-only memory can retain more than one learned topic route and
use it after an intervening topic. It also shows that transitive attribution controls how
far a path collapses: A learned C when attribution stopped there, but learned terminal F
when F's identity and address propagated all the way back. The latency differences are
descriptive; warmed model sessions confound a causal speed estimate.

## Harness lesson

A deliberately interleaved run in the old sibling-directory layout was invalid: F listed
its parent, read `network.json` and every sibling `AGENTS.md`, then became an accidental
omniscient broker. A nested macOS sandbox blocked both that shortcut and legitimate curl
execution, so it was discarded. Separate ordinary runtime roots preserved curl behavior
without adding a second security system. The harness now uses that layout and keeps only
the trace archive central.

This is runtime separation for a benign experiment, not adversarial isolation. A broad
temporary-directory scan, the original scenario source, and global Codex state remain
outside its guarantee.

## Current conclusion

Keep the universal prompt and opaque `/ask` boundary. Do not add router/end-node types,
numeric trust, routing files, or a harness routing policy yet. Birds already exhibited
hub behavior, terminal behavior, multi-source reconciliation, contextual self-answering,
and topic-specific route shortening. Contributor propagation and occasional redundant
verification remain stochastic; the next useful tests are unlabeled discovery, repeated
quality conflicts, compaction, and larger uneven flocks—not more tuning to one ledger.
