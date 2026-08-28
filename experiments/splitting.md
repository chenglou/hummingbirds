# Splitting experiments

Can a bird create another genuinely independent bird without adding a flock
manager, routing registry, specialization policy, or separate hosting service?

Historical trials established independent creation, selective teaching, and
useful specialization without those additions. They used an earlier birth
transport, not the CLI creation mechanism now described in the README. Birds
chose whether to create a peer, what it should know, and whom to introduce
through ordinary messages.

The isolated runner recorded 46 real-model scenario runs with model activity,
totaling 554 model turns, 41 accepted births, and 17,554,340 input tokens, of
which 15,017,216 were cached. Additional direct lifecycle probes verified
ancestor death and multigeneration independence. Every recorded disposable bird
process was stopped.

## Independent lifetimes

Each accepted birth in these trials started the same server in its own ignored
`bird-<id>/` directory and persistent Codex conversation, with no private seed
and only its parent as an initial peer. Its actual ID and address were returned
to the requesting bird.

The parent process does not own the child's lifetime. A real four-generation
experiment created parent → child → grandchild, terminated the original parent,
verified that the remaining birds independently recalled different private
facts, and watched the orphan grandchild create and teach a great-grandchild.

The historical birth path defaulted to a ceiling of 32 retained child
directories. Each directory acted as an atomic birth reservation: competing
parents could not exceed the ceiling, and a rejected reservation was removed
before any new process started. No shared coordinator, process registry, or
generation hierarchy was required.

A separate 2026-08-27 mechanism check verified ordinary CLI creation and startup
through scoped rules on macOS and Linux, including independent descendants,
same-thread restart, and ordinary-tool write boundaries. Those trials used
exact rules for named disposable birds, not the current arbitrary-ID rules or
another specialization comparison. Evidence is in ignored
`logs/scoped-cli-birth-2026-08-27/README.md`.

The production-shaped CLI integration was then tested in one lineage scenario
on each of macOS and Linux: seven real-model turns per platform, two independently
created descendants, successful recall after ancestor shutdown, and same-thread
recall after the grandchild's own restart. Ordinary writes to the runtime and
generated rules were denied, and all 40 macOS and 63 Linux captured process
identities exited naturally. This used the current arbitrary-ID rules and shared
creation limit. An initial command quoting failure was diagnosed and corrected
before the successful run. These are lifecycle checks, not new specialization
results. Evidence and limitations are in ignored
`logs/cli-birth-integration-2026-08-27/README.md`.

## August 27 CLI behavior check

Five fresh workload cases on 2026-08-27 used the then-production capability-only prompt,
synthetic facts, and random UUID request IDs. None created a bird during ordinary
traffic. After the same broad organizational-review cue used historically:

- Two mixed-topic cases coordinated human callers without attempting a birth.
- One coherent-topic control shared a checklist without creating another bird.
- One existing-peer case reused gardening and astronomy peers selectively.
- One mixed-topic case, additionally told that its human inboxes were not bird
  workers, chose to create astronomy specialist Astra and keep gardening itself.

Astra was actually created and started through the ordinary CLI, taught via
POST, then restarted alone after its parent stopped. It retained all taught
astronomy facts on its own thread and reported garden facts as unknown, without
consulting peers or other conversations.

Two fresh pre-change controls used the same workloads and UUID-based runner:
the plain mixed case made no birth attempt, while the topology-informed case
created two useful specialists. Thus self-chosen specialization still works
with the CLI. These small, adaptive trials do not establish spontaneous birth
rates, equal reliability, or the isolated causal effect of the topology message.

Failures matter too. The existing-peer case and one mixed repeat physically
delivered messages but put routing fields in the body instead of HTTP headers,
breaking harness correlation. The reused peers retained useful subsets, not all
potentially relevant old facts. Astra's recall omitted its source's full address
and topic. Useful specialization does not imply perfect protocol, handoff, or
attribution behavior; no prompt fix was made during these tests.

The current cases totaled 57 model turns; all 240 captured process identities
exited without forced cleanup. The behavior cases ran on macOS; Linux separately
verified the mechanism above. All outcomes, raw headers, source snapshots,
native-call audits, and pre-change controls are preserved in ignored
`logs/cli-birth-behavior-2026-08-27/README.md`.

## One real cascade changed the design

An early real experiment used the descriptive request ID `create-child`. The
first newborn received only a harmless fact, but its envelope also contained
`Request: create-child`. It interpreted that routing metadata as an instruction,
created another bird, and propagated the same ID. A second descriptive request
triggered a parallel branch. The isolated run grew to eight bird servers and
seven active Codex turns before it was contained.

The current protocol rejects request IDs unless they are canonical UUIDs, so a
descriptive value such as `create-child` cannot reach a model. Birds see the
actual `x-request` or `x-in-reply-to` header, never both; `x-route` separately
carries the current message path. This preserves asynchronous correlation
without turning caller-controlled words into instructions. The local birth
ceiling separately limits the consequences of any future model mistake.

## Specialization does not need a splitting rule

The capability-only prompt in these trials merely disclosed how to create a
local peer. An extra general-purpose instruction was tested against otherwise
identical scenarios:

> Split when some coherent part of your knowledge, work, or relationships would
> be more useful as its own independently addressable conversation.

Three matched mixed-topic repetitions per arm produced:

| Prompt | Children per run | Model turns | Average input tokens |
| --- | --- | --- | ---: |
| Capability only | 2, 2, 1 | 17, 19, 11 | 493,934 |
| Capability plus splitting rule | 2, 2, 2 | 17, 17, 19 | 566,820 |

Every run produced a useful specialist. An additional capability-only run
created one astronomy bird while retaining gardening in its parent. At that
stage, the general rule was removed: it added words, encouraged a more uniform
organizational shape, and was unnecessary for the observed behavior. It was
later adopted as a provisional policy in `a426003`, after the ordinary-traffic
experiments and further matched repetitions; see [the later record](splitting-ordinary-traffic.md).

These workloads included a broad organizational-review message. Sampled
successful mixed cases split at that review, not during the preceding ordinary
messages. The old runner also exposed semantic step names through descriptive
request IDs. Those counts are not spontaneous-birth rates or controlled rates
for the current UUID-based protocol; the labels are a possible confound, not a
demonstrated cause.

The birds chose multiple legitimate boundaries:

- Separate gardening and astronomy specialists.
- Separate stewards for two different garden owners, despite both working on
  the same broad topic.
- One neutral shared garden-records specialist that preserved both owners'
  distinct information without claiming either role.
- A cross-project backup steward for original irrigation and telescope designs.
- Existing live specialists instead of unnecessary newborns.

Knowledge transfer remained selective: descendants independently recalled the
facts they were taught and correctly reported unknown when asked about withheld
facts from their parent's conversation.

## Organization needs truthful topology, not more rules

A preceding investigation used a temporary hosting peer. Its results here
describe organizational behavior, not the later birth transport, and are
separate from the 46-run totals above.

A marginal-benefit instruction correctly suppressed an unnecessary split of one
coherent specialty, but also suppressed a useful split of two distinct ones. The
bird had mistaken two human caller identities for independently running peers.
When an ordinary message explained that those identities shared one inbox and
were not separate workers, the same policy handled both cases: zero unnecessary
children for one specialty, and one useful specialist for two. Existing live
specialists were reused when available; same-topic boundaries could instead
follow distinct owners or audiences.

Thus a caller name or reply address does not establish an independent execution
lane. The experiment supplied its topology observation manually; the production
runtime does not infer or inject it. Decisions about ownership, delegation, and
splitting can remain conversational when their relevant facts are observable.

## Attention policy matters more than prompt detail

In another earlier matched workload, both prompts correctly avoided new birds.
The concise prompt took **20 turns and 545,983 input tokens**; an overly
prescriptive prompt took **116 turns and 4,959,125 input tokens** because
broadcasts and acknowledgments activated other birds. Equal birth counts hid
nearly six times as many turns and nine times as much context traffic.

A separate ordinary operating message asked a bird to retain updates, forward
only to peers with demonstrated interest, and avoid acknowledgment chatter.
The same workload fell from **75 to 31 turns** and from **2,574,663 to 964,816
input tokens**, including the instruction itself. No routing registry,
subscription system, or specialized tool was required.

## Public research, original work, and real concurrency

One blank child received a synthetic private planning label, used real web
search to inspect an official National Park Service source, and retained its
parking-reservation and cellular-service findings. Its public search did not
contain the private label. A later direct question combined the retained private
and public facts without another search or call to its parent.

Another bird invented a gravity-fed irrigation design and a passive telescope
dew-prevention design with concrete engineering tradeoffs. It later created a
specialist responsible for preserving both original designs rather than
partitioning them by topic.

Two simultaneous messages sent to one bird necessarily ran serially: a quick
answer waited behind a slow turn. The corresponding request sent to an
independent child ran concurrently with its parent's slow turn and finished
first. Splitting creates actual independent execution lanes; prompting one
conversation cannot.

Files neither universally prevented nor caused specialization. One bird used
local notes instead of creating a worker, while other birds wrote notes and
still created coherent records specialists. An earlier optional context-only
instruction produced a file-free specialist that passed all seven handoff and
recall checks in 23 turns. This is cooperative behavior, not an enforced
security boundary: another bird read a sibling experiment's fixture through
shared `/private/tmp` despite having its own conversation and workspace.

## Twelve birds, then thirteen

A larger run started twelve birds across four unlabeled branches, with gardening,
astronomy, materials, and unrelated expertise at different depths. All six
scenario checks passed; the flock eventually contained thirteen birds and used
46 turns and 1,854,285 input tokens.

- The first gardening lookup traversed `n0 → n1 → n2 → n3`, taking seven turns
  and 115 seconds.
- A withheld follow-up went directly from `n0` to the remembered source `n3`,
  taking three turns and 33 seconds.
- An unfamiliar materials lookup searched seven birds before finding its source,
  taking 199 seconds.
- A newly created materials specialist independently recalled its assigned facts
  in 15 seconds without contacting any other bird.
- A later astronomy lookup avoided that unrelated specialist but still searched
  nine existing birds and took 324 seconds.

One-peer-at-a-time exploration limits simultaneous fanout, but does not prevent
expensive serial wandering. Broad contributor lists also credited intermediaries
and unsuccessful search branches, so attribution still needs better semantic
selectivity before remembered routes reliably converge.

## Important limits

- Organizational-review messages themselves strongly encourage action. In a
  matched single-topic control, both prompt variants sometimes created a
  redundant backup/coordinator despite no demonstrated distinct audience,
  workload, or specialty. The open question is an observable threshold for when
  the extra independent bird is actually worthwhile.
- Accepted delivery is not completed processing. Explicit read-after-write
  confirmation establishes a processed handoff using ordinary messages and the
  existing per-bird queue.
- Acknowledgment-only exchanges can still create unnecessary turns, and broad
  discovery can flood peers. Learned direct routes and interest-specific
  forwarding help but do not constitute a hard global traffic bound.
- The historical ceiling counted retained `bird-*` directories, not live
  operating system processes. Stopped birds retained their slots while their
  persistent state remained.
- The earlier birth transport was loopback-only and shared among local callers.
  These experiments did not establish cross-user isolation; public or
  cross-user operation needs an actual authorization and filesystem boundary.
- Splitting copies useful information through conversation; it does not erase
  the same information from its parent's existing context.
