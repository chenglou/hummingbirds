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

## Harness cleanup

- Define abrupt shutdown: `stopNetwork` kills a bird's server but not a Codex turn still in flight; decide whether to drain or terminate descendants.
- Local birds can read each other's directories (the sandbox restricts writes, not reads). Separate them only if a bird starts cheating by reading a sibling's seed, events, or shared Codex state.
