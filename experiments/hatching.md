# Hatching experiments

Can a bird create another genuinely independent bird without adding a flock
manager, routing registry, specialization policy, or separate hosting service?

Yes. Each bird's existing Bun server can launch a detached sibling outside its
Codex shell sandbox. The bird chooses whether to hatch, what the child should
know, and whom to introduce through ordinary messages.

The isolated runner recorded 46 real-model scenario runs with model activity,
totaling 554 model turns, 41 accepted births, and 17,554,340 input tokens, of
which 15,017,216 were cached. Additional direct lifecycle probes verified
ancestor death and multigeneration independence. Every recorded disposable bird
process was stopped.

## Runtime boundary

`POST /hatch` accepts a plain-text bird ID and returns the new bird's ID and
address. The child starts the same server, uses its own ignored `bird-<id>/`
directory and persistent Codex conversation, begins with no private seed, and
starts with only its parent as an initial peer.

The parent process does not own the child's lifetime. A real four-generation
experiment created parent → child → grandchild, terminated the original parent,
verified that the remaining birds independently recalled different private
facts, and watched the orphan grandchild hatch and teach a great-grandchild.

A local ceiling defaults to 32 retained child directories and can be configured
with `HUMMINGBIRDS_HATCH_MAX_BIRDS`. Each directory is its own atomic birth
reservation: competing parents cannot exceed the ceiling, and a rejected
reservation is removed before any new process starts. No shared coordinator,
process registry, or generation hierarchy is required.

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

The production prompt only discloses that local hatching exists. An extra
general-purpose instruction was tested against otherwise identical scenarios:

> Split when some coherent part of your knowledge, work, or relationships would
> be more useful as its own independently addressable conversation.

Three matched mixed-topic repetitions per arm produced:

| Prompt | Children per run | Model turns | Average input tokens |
| --- | --- | --- | ---: |
| Capability only | 2, 2, 1 | 17, 19, 11 | 493,934 |
| Capability plus splitting rule | 2, 2, 2 | 17, 17, 19 | 566,820 |

Every run produced a useful specialist. An additional capability-only run
created one astronomy bird while retaining gardening in its parent. The general
rule was removed: it added words, encouraged a more uniform organizational
shape, and was unnecessary for the observed behavior.

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

A preceding investigation used a temporary hosting peer before `/hatch`
existed. Its results here describe organizational behavior, not the current
endpoint, and are separate from the 46-run totals above.

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

In another earlier matched workload, both prompts correctly avoided hatching.
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
- A newly hatched materials specialist independently recalled its assigned facts
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
- The local ceiling counts retained `bird-*` directories, not live operating
  system processes. Stopped birds conservatively retain their slots while their
  persistent state remains.
- Loopback limits remote access to `/hatch`, but local callers share it. Real
  cross-user isolation or publicly deployed hatching would need an actual
  authorization and filesystem boundary.
- Splitting copies useful information through conversation; it does not erase
  the same information from its parent's existing context.
