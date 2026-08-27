# Request IDs, overlapping conversations, and follow-through

2026-08-26. IDs are useful but not fundamental: they carry the association that otherwise has to live in the message's words or be recovered through clarification. Removing them unchanged produced confident mistakes on ambiguous replies; it did not prevent contextual routing, remembering interested peers, or unsolicited updates.

## Comparison

Fresh birds, pinned Codex CLI 0.149.1, `gpt-5.6-sol` with high reasoning. The baseline was a byte-identical copy of production. The treatment removed `x-request`, `x-in-reply-to`, and the request-ID environment variable; replies instead carried `x-reply: 1`. Sender identity, callback address, route, FIFO processing, reply-cycle exemption, and failure-loop suppression stayed intact. Native conversation IDs and local invocation IDs were not removed.

There were 156 real model turns across 40 fresh birds: 22 single-router trials (including four excluded fixture attempts) and six fully real three-bird flocks. This was not an app-server migration. Existing local birds, `temp/{a,b,c}`, and the hosted flock were untouched. No production changes were made.

## Delivered-answer results

The controlled trials used a real A and scripted HTTP sources B/C so reply order was deterministic. Both human requests had to reach the sources and A had to finish the sending turns before any answer was released. Both humans identified themselves as `human` but had different callback addresses; the revision case deliberately reused one address. Judging used actual HTTP inbox bodies and destinations, not final assistant narration or correct ID formatting.

| Scenario | With IDs | No IDs | No IDs + clarification instruction |
| --- | --- | --- | --- |
| Contextual replies, reversed order, two pairs | 4/4 answers correct | 4/4 correct | Not tested |
| Same, with A restarted while both questions were open | 2/2 correct | 2/2 correct | Not tested |
| Two sources, interleaved partial answers | Both complete answers correct | Both correct | Not tested |
| Caller changes Saturday to Sunday; old Saturday answer arrives late | Sunday delivered; obsolete Saturday ignored | Same | Not tested |
| Bare times, reversed order, two pairs | 4/4 correct | **0/4: both answers swapped in each run** | 2/2 correct in one follow-up trial |
| Bare times, original order, one pair plus control | 2/2 correct | 2/2 correct | 2/2 correct |

The decisive example: H1 asked Saturday's time, H2 asked Sunday's, and B's Sunday response arrived first as just `11:15 a.m.`. Without IDs, A confidently told H1 that Saturday was 11:15, then told H2 that Sunday was 10:30. In a fresh repetition with different times it made the same swap. FIFO happened to work because the guessed association matched the delivery order; it did not make the input unambiguous. With IDs, A matched all these terse replies correctly. With the day included in the body, both protocols worked.

No unsuperseded request was forgotten in the completed trials. The errors were misassociation, not dropped follow-through. Correctly ignoring an obsolete or already-answered message is not a failure. The previously discussed “remember pending answers” reminder was therefore not tested.

After observing the swaps, a separate no-ID variant added exactly:

> When a reply could refer to more than one open exchange, clarify which one it answers rather than assuming from arrival order.

It asked one clarification in each of two trials, then delivered both correct answers without first sending a guess. The scripted source responded with a full day-labeled schedule; this was clarification-assisted recovery, not deduction of absent information. Each run used five A turns instead of four, plus the extra peer exchange. The later terse answer was recognized as redundant. This is a promising small alternative to mandatory IDs, not a reliability guarantee.

## Interest memory and unsolicited messages

In each fresh three-bird flock, A asked B/C about public seed swaps and unusual tomatoes. Later B/C received unrelated bulletins, then relevant announcements, with no return address and no instruction to notify A. A recall probe came last, so it could not prime forwarding.

Across three matched pairs, both protocols recovered A's exact address and interest in 6/6 recipient probes. Relevant notifications reached A in 2/6 opportunities with IDs and 1/6 without; each protocol produced one actual proactive update to the original human. No unrelated bulletin was forwarded, and every initial inquiry received a substantive answer. The third pair was exploratory, selected after the initial 2/4 versus 0/4 gap, and reversed that pattern. These small, clustered samples do not establish a notification-rate difference.

The successful with-ID notifications used the new announcement's ID, not the original inquiry's ID. The routing back to an interested peer/human already depended on remembered context and addresses. The successful no-ID C → A → human exchange confirms that capability directly. Silence after an announcement was not a forgotten promise: the initial question had already been answered and no ongoing subscription had been requested.

## Fixture exclusions and other observations

- Both first revision attempts were excluded after two turns: the fixture initially misread “disregard Saturday” as asking for Saturday. The birds' corrections were sensible. The fixture was fixed and both arms rerun fresh; source-reply correlation always came from actual received requests, never the observer's expected answer mapping.
- Both first fanout attempts were excluded after one turn: A asked C for the location but omitted the day. The original human wording was less explicit about the location's day. A fresh pair with the day stated separately for both source questions passed. This omission is retained as an observation; IDs do not give a source semantic context it never received.
- One no-ID revision run omitted `x-route` on three POSTs after calling this Mac's `printenv` with multiple names, receiving only the first value, then sending an empty header. A harmless local probe reproduced the utility behavior. The runtime had not removed the route environment variable. This incidental tool-portability mistake did not affect the acyclic answer test but would weaken loop protection.
- Two runs delivered literal `\n\n` separators. This affected formatting, not answer matching. Some parallel curl commands emitted nonfatal `nice(5)` warnings.
- No native turn failures, rejected deliveries, failed shell commands, hidden request-ID leakage, external searches, neighboring-state reads, or knowledge-file writes were observed. The scripts do not implement pending-answer memory for the birds. All generated workspaces retained only their unchanged `AGENTS.md`.

## Interpretation and limits

These experiments test overlapping asynchronous exchanges, not interruption of a running model turn: A finishes sending Q1, processes Q2 while Q1 is still unanswered, then processes the later replies. FIFO still serializes turns. IDs do not schedule follow-up work or guarantee a reply; the harness has no outstanding-obligations table.

History review found that request IDs were introduced early for overlapping-question correlation, not in response to a measured no-ID failure. The old simulation's explicit pending map and today's fake-model tests do not answer this behavioral question. Here we have a concrete benefit and a concrete prompt-based alternative.

The samples are short, use one model, and do not test compaction, long absences, lossy peers, or large concurrent workloads. The ambiguity control was a follow-up, not part of the initial fixed comparison. A source that always gives full context reduces the need for IDs; a terse source increases it. Nothing here warrants claiming that IDs are essential to specialization, discovery, or interest memory, or that the clarification line is universally reliable.

Plaintext scenarios above are the reusable specification. Local ignored evidence, exact messages, frozen runtime variants, runner revisions, and reproduction notes are in `logs/id-ablation-2026-08-26/`. All 496 captured experiment process identities were checked and were gone. No commit was made.
