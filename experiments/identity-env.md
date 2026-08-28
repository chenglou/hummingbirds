# Identity from the prompt, not environment shortcuts

2026-08-26. Removing `HUMMINGBIRDS_NODE_ID` and `HUMMINGBIRDS_NODE_ADDRESS` produced no observed sender/callback copying errors. Across all runs, the treatment sent 75/75 actual messages with its correct own identity and full return address; the control sent 70/70 correctly. Protocol UUIDs and request/reply kinds were also correct on all 145 messages. This supports the cleanup, not a claim that every conversation behavior is unchanged.

The request-ID cleanup was committed first as `762fdd3`. The two identity removals were adopted in the source and prompt template on 2026-08-27, using the tested wording. Existing birds and their saved prompts were not modified. The birth scenarios below used an earlier transport; they did not test the current CLI creation rules.

## Comparison

Control: the committed prompt and runtime, with request IDs already copied from the incoming envelope. Treatment: additionally clear the two identity shortcuts and replace their prompt references with “`x-from:` with your own ID, `x-reply-to:` with your own full address.” Those values already exist in generated `AGENTS.md`. No replacement environment variables or extra incoming fields were added. `HUMMINGBIRDS_ROUTE`, exec/resume, UUID validation, queues, and all other settings stayed unchanged.

Both variants had identical passive raw-header observers. A fake-child check confirmed byte-identical incoming messages, unchanged route values, request-ID shortcut absent in both, and identity shortcuts absent only in treatment—even with stale values inherited from a parent. Real trials used fresh isolated workspaces, native Codex CLI 0.149.1, `gpt-5.6-sol`, high reasoning, and the normal login without credential copies or `CODEX_HOME` changes.

There were 20 fresh real birds, 154 started turns and 152 native `turn.completed` events. Two first-round runs stalled. One fresh repeat of each affected scenario ran control then treatment, lowering concurrency without changing prompts, cases, or timeout bounds. Initial results were retained, not replaced.

## Scenarios and delivered answers

- **Overlapping replies:** eight questions from three human inboxes; B withholds replies until all are outstanding. Insert an unrelated new message and an old partial reply, restart A on the same thread, then release bare times out of order. Check that A keeps advertising its own identity rather than copying B's or a human's callback address.
- **Real forwarding:** A knows B, B knows C, and C knows four fictional announcements. Ask three concurrent questions, drain, restart A, then ask a held-out fourth question. Inspect actual peer and human POSTs, contributor propagation, and route choice.
- **Independent child:** parent `reed-17` creates `reed-17a` through the earlier birth transport, teaches it a fact, and reports the child’s actual address. Contact the child after stopping its parent, then restart the child on its existing thread and ask again. Check that the child uses its own identity, not the parent's.

| Scenario | Control answers | No identity shortcuts |
| --- | --- | --- |
| Original overlapping replies | 3/8; timeout, only three final source replies released | 8/8 |
| Original real flock | 4/4 | 3/4; source turn timed out |
| Independent child and restart | 3/3 | 3/3 |
| Fresh overlap repeat | 8/8 | 8/8 |
| Fresh real-flock repeat | 4/4 | 4/4 |

All delivered answers were correct. Four direct warmup echoes also passed and are included in the 145 message POSTs, but not in the answer table. Counts cover peer and human messages, not birth-control POSTs: both parent birth requests targeted their own server and created the intended child.

Scoring used raw headers before receiver defaults, actual delivered bodies/inboxes, and the command-emitting bird plus its active turn—not the output's claimed sender as its own ground truth. Missing IDs, callbacks, sender fields, and failure callbacks could not silently count as success. Control sometimes inspected its environment and then used literal values; this compares shortcut availability with removal, not forced shell expansion with forced copying.

## Qualifications and other observations

- The original control overlap run delivered Oak's correct answer before timing out waiting for the turn to close. Five later source answers were never injected; those are untested, not demonstrated forgotten answers. The harness eventually recorded completion during cleanup, but no corresponding native `turn.completed` was present.
- In the original treatment flock, C emitted `thread.started` and `turn.started` for the held-out question, then no command or answer before the deadline. Cleanup caused its exit error; no malformed message or failure callback preceded it. The logs do not establish why either run stalled. Both fresh repeats completed; this is not proof of a latency/reliability difference.
- The control child omitted `x-route` on three replies. It ran multi-name `printenv`, which on this Mac returned only the first variable, then sent literal empty route headers. A separate harmless probe reproduced that shell behavior. The route environment had not been removed. Treatment routes were all correct. This is a distinct tool-use error, not an identity error.
- Direct-peer reuse varied. Both first-round A birds contacted C directly after restart, but repeat treatment A went through B despite having received C's exact ID/address/topic in three earlier replies. The answer remained correct; no explicit rationale for using B was logged. Do not infer missing memory, broken contributor propagation, or causation from this small sample.
- Repeat control B spontaneously tried to create `d` through the earlier birth transport. It addressed its own server and supplied the correct identity; the existing three-bird cap refused creation. The command response was recorded, not an independently measured HTTP status. No fourth bird was created.

No compaction, long-history, custom public-address, or other-model claims follow from these tests. When the identity change was adopted, the offline fixture was updated to read the generated prompt too, with stale-alias checks for forwarding and child creation. Existing saved bird prompts need updating separately before restarting them on the new code.

Frozen sources, runners, raw streams/headers, independent analyses, and combined `summary.json` are in ignored `logs/identity-env-2026-08-26/`, including the unchanged first round and fresh `repeat/`. All 504 recorded PID/start identities were gone at final verification; an additional scoped working-directory check found no leftovers. Existing local/hosted birds and previous experiment evidence were untouched.
