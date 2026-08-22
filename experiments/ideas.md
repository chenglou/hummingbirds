# Ideas

Unfinished directions from the exploration. These are options, not commitments; keep the benign core small until an experiment justifies more structure.

## Learning over time

- Stress one continuing bird context across many subjects and failures: reconcile conflicting evidence, prefer shorter routes, revise stale generalizations, and see what survives compaction.
- Compare prose-only routing with occasional exploration of unfamiliar peers. Try success counts, softmax, embeddings, or other representations only if prose stops working; trust should remain local rather than becoming global PageRank.
- Eventually let each node choose its own routing storage—file, database, embedding, or model memory—while the network requires only text replies and useful contributor attribution.

## Answer quality and fallback

- Test independent verification of conflicting replies without counting one contributor reached through different paths as multiple votes.
- Test chains whose immediate caller cannot judge the answer. Compare local avoidance, evaluation at each return hop, and delayed human or external feedback before adding backward reputation.
- Exercise real web, code, database, and other node-owned capabilities. A person can be an opaque answer endpoint while an adjacent agent handles routing; notify the owner only when progress genuinely requires them.
- Test heterogeneous nodes: cheap, fast models by default, with a stronger model or human consulted only after the local network stalls.

## Scale and topology

- Scale the cleaned harness from three to 12–24 nodes across several topics, with cold-to-warm routing, one stale route, queued concurrent questions, and uneven load. Watch for emergent clusters, hubs, hierarchy, specialists, or router-like nodes before prescribing roles.
- Test overload-driven node splitting and whether a specialty divides cleanly without central assignment.
- Give hosted birds durable workspaces and stable addresses around their persisted Codex sessions.

## Actual distribution

- Move from centrally launched loopback processes to long-lived nodes on different hosts: stable identity despite changing addresses, bootstrap/join discovery, restart and resume, churn, unreachable peers, late replies, retries, and backpressure.
- Keep discovery bounded by each node's real capabilities and contacts, while allowing referrals to grow the graph without a global directory or small hop budget.

## Later human and adversarial layers

- Punt ownership, abandoned or free-roaming agents, and claiming/reassignment. Later add human workflows for curating and growing private knowledge.
- Continue assuming benign peers for now. Add defenses against persistent bad answers, spam, fake identities, collusion, and privacy leaks only after the open network exists.

## Mailbox delivery, observed

Findings from the first real-Codex runs with `x-hummingbirds-reply-to` (chain and a 6-bird mood graph), from before and after the harness went mailbox-only; to revisit rather than fix now:

- While waiting on the line was still an option, birds took it even when nobody was waiting on them. Asked to "send what you have as it comes in", the entry bird did switch: it replied with its own part at once, asked both peers with reply-to pointing at itself, ended its turn, and relayed each `Re:` to the human as a separate turn. Three replies to one request, correctly tagged, no harness state. First mailbox-only run of the mood graph: the entry bird asked two peers, ended its turn, said nothing to the human until both branches were in, then sent one roll-up covering all five reachable birds; a middle bird sent an interim report and then a complete one. The bookkeeping held across four open turns. Watch whether it still holds once several requests are open at once.
- The same "how is everyone feeling" question covered the whole reachable graph in two runs and only one hop in another. The difference was whether the entry bird's rewrite of the question kept the "and who else can you reach" clause. A verbatim forward would have walked every time; the rewrite is where coverage gets lost. Don't special-case this, but it's a reason to keep the "forward verbatim" line.
- Contributor attribution closes loops fast: after two peers named d and e, the entry bird called d and e directly within the same turn to confirm. Two extra calls, but from then on it knows them first-hand.
- Before the prompt said which part of a message to forward, a bird forwarded the whole envelope, `Reply-to:` included, so three birds each replied to the human. Model slips with `curl` (a body left in a shell variable, an unset variable) produced empty replies twice; the bird recovered once on its own. Birds and the inbox now answer 400 to an empty body, so the next slip is visible to the sender. Birds also sometimes copy the `From:`/`Re:`/`Reply-to:` lines into the body of their own replies (both birds in one chain run, none in the mood run); harmless, the receiving bird reads past it fine. Worth a line in the prompt only if it starts confusing anyone. If slips keep happening, the fix is probably a note in the prompt about `--data-binary @file`, not more harness.
- A bird's final message goes nowhere by design, and birds sometimes say something there anyway ("Reply delivered"). Harmless, but it's wasted tokens in the conversation; see whether it fades.
- Two branches of one request could wait on each other forever while calls held the line: a asks b and c, b forwards to c while c forwards to b, and each sits in the other's serial queue. Mailbox-only removed that whole class, and the "already on this request" 409 with it: a question is accepted at once and answered whenever the bird gets to it, so one queue never waits on another. A question arriving back at a bird it already went through is still a 409, since nothing else would stop it going round forever.
- Codex's shell tool hands control back after a yield time the model picks (it picked 30 s) and keeps the command running. While calls held the line, one bird lost track of a running call that way and asked the peer again under a fresh request id (`<id>-c-direct`), re-running its whole subtree. A call now returns in milliseconds, so this can't recur.
- A message with no reply-to is accepted and acted on, nothing more. First try: told the entry bird "no reply needed, the dock code for Nacre-Q is X, keep it with your notes", it wrote a `notes.md` in its workspace and said nothing to anyone; asked the code through the inbox a moment later, it answered from the note in 12 s. Commands to the flock work with no harness for them. A human poking a bird by hand with plain `curl` gets a 202 and finds the bird's closing words in `events.jsonl`, which is enough for now.
- The human's inbox accepts a reply with no `in-reply-to` and the CLI prints it as unmatched. A bird that slips on that header gets a 202 and no hint. Leave it unless it shows up in practice.

## Harness cleanup

- Define abrupt shutdown: `stopNetwork` kills a bird's server but not a Codex turn still in flight; decide whether to drain or terminate descendants.
- Local birds can read each other's directories (the sandbox restricts writes, not reads). Separate them only if a bird starts cheating by reading a sibling's seed, events, or shared Codex state.
