# Copying request IDs from the message envelope

2026-08-26. Removing only the `HUMMINGBIRDS_REQUEST_ID` shortcut passed all three matched stress comparisons. The birds copied the right UUID from the message text, including when several exchanges were outstanding. This supports removing that shortcut; it does not support removing protocol IDs. Production is unchanged.

## Setup

Ten fresh birds, 96 real model turns, pinned Codex CLI 0.149.1, `gpt-5.6-sol` with high reasoning. Each scenario ran once with the shortcut available and once without it, using the same questions and UUIDs but independent fresh conversations.

The treatment cleared the request-ID environment variable and changed only two prompt bullets: use the exact ID from the incoming `x-request:` or `x-in-reply-to:` line in the appropriate outgoing header. Both variants retained exec/resume, canonical UUID validation, the existing envelope, all other environment shortcuts, route handling, and serial model turns. No extra message field was added. A fake-child check confirmed that an inherited request-ID variable could not leak into the treatment.

## Reusable scenarios

1. **Real forwarding and a learned shortcut.** A knows B, B knows C, and C knows four fictional meeting announcements. Three human inboxes ask A different questions concurrently. Observe actual A → B → C → B → A → human messages. Restart A with its existing thread, then ask the fourth question without suggesting C. In both variants A contacted C directly and returned the correct held-out fact.
2. **Eight open questions.** A receives eight workshop-time questions within milliseconds, distributed across three human inboxes. A asks scripted source B; B acknowledges but withholds answers until all eight questions are outstanding. Send A an unrelated message with a fresh ID, then an older partial reply. Restart A with the same thread. Release bare times in shuffled order. Check each answer's subject, time, original ID, and destination, including multiple questions sharing an inbox.
3. **Nearly identical IDs.** Repeat the controlled sequence with four valid UUIDs differing only in their final character. Keep the partial reply, unrelated intervening ID, restart, and shuffled bare-time replies. This is a constructed copying/selection boundary case, not a proposed ID generator.

In the controlled scenarios, B's replies used the IDs actually received from A, never IDs repaired from the expected-answer table. All questions genuinely reached B before replies were released. Model turns still ran sequentially; the overlap was between unanswered exchanges, not simultaneous turns in one bird.

## Results

| Scenario | Exact IDs, shortcut available | Exact IDs, shortcut removed | Correct substantive answers, each variant |
| --- | ---: | ---: | ---: |
| Real three-bird flock | 18/18 | 18/18 | 4/4 |
| Eight open questions | 17/17 | 17/17 | 8/8 |
| Four nearly identical IDs | 9/9 | 9/9 | 4/4 |
| Total | 44/44 | 44/44 | 16/16 |

The POST totals include one direct warmup reply per controlled run; all four warmups were also correct. Across both variants there were 88 actual model POSTs, 32 substantive answers, and four warmups.

No missing, malformed, mutated, or wrong-exchange IDs; no incorrect request/reply headers, routes, senders, or callback addresses; no rejected POSTs, command failures, native failures, or harness failure callbacks. No unsuperseded question was forgotten. We checked actual delivered bodies and inboxes, not assistant claims that a message was sent. Raw headers were recorded before validation/defaulting, so a server-generated UUID could not hide an omitted header. An independent audit checked source-turn windows and semantic question/answer matching. Runtime and prompt hashes remained unchanged throughout each run.

The control used the shortcut in only 16/44 commands: 11/18 in the real flock, 0/17 in the eight-question test, and 5/9 in the lookalike test. It voluntarily copied IDs literally in the others. The treatment used it zero times. This is **shortcut available versus removed**, not forced environment expansion versus forced copying.

## Interpretation and limits

Literal UUID copying looks good enough for this small cleanup. Keeping the request/reply IDs still supplies the association needed for bare, delayed answers; the bird no longer needs a second copy in its environment. This does not establish equal error rates, reliability after compaction or long histories, behavior on other models, or removal of the route/identity shortcuts. There was one matched pair per scenario, and the scripted bare replies were deliberately adversarial about ambiguity.

If adopted, the fake Codex fixture also needs to read IDs from the input envelope instead of the removed shortcut. No production implementation or app-server migration was made here.

Frozen sources, runners, raw streams/headers, answer bodies, and machine-readable scoring are under ignored `logs/literal-id-2026-08-26/`. All 307 recorded process identities were gone at the final audit, and a scoped working-directory process check found no leftovers. Existing `temp/{a,b,c}`, the default local flock, hosted birds, and prior experiments were untouched. No commit was made.
