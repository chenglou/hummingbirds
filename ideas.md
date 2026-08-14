# Ideas

Unfinished directions from the exploration. These are options, not commitments; keep the benign core small until an experiment justifies more structure.

## Learning over time

- Grow `knowledge.md` from human-supplied private knowledge and vetted discoveries. Today only routing memory grows.
- Stress one `nodes.md` across many subjects and failures: deduplicate and compress it, reconcile conflicting evidence, prefer shorter routes, revise stale generalizations, and handle concurrent writes.
- Compare prose-only routing with occasional exploration of unfamiliar peers. Try success counts, softmax, embeddings, or other representations only if prose stops working; trust should remain local rather than becoming global PageRank.
- Eventually let each node choose its own routing storage—file, database, embedding, or model memory—while the network requires only text replies and useful contributor attribution.

## Answer quality and fallback

- Test independent verification of conflicting replies without counting one contributor reached through different paths as multiple votes.
- Test chains whose immediate caller cannot judge the answer. Compare local avoidance, evaluation at each return hop, and delayed human or external feedback before adding backward reputation.
- Exercise real web, code, database, and other node-owned capabilities. A person can be an opaque answer endpoint while an adjacent agent handles routing; notify the owner only when progress genuinely requires them.
- Test heterogeneous nodes: cheap, fast models by default, with a stronger model or human consulted only after the local network stalls.

## Scale and topology

- Scale the cleaned harness from three to 12–24 nodes across several topics, with cold-to-warm routing, one stale route, and concurrent questions. Watch for emergent clusters, hubs, hierarchy, specialists, or router-like nodes before prescribing roles.
- Test overload-driven node splitting and whether a specialty divides cleanly without central assignment.
- Resolve concurrent `nodes.md` updates without moving route choice into the harness.
- Compare fresh model calls with resident per-node sessions; if residency repeatedly helps, warm nodes lazily rather than warming the whole graph.

## Actual distribution

- Move from centrally launched loopback processes to long-lived nodes on different hosts: stable identity despite changing addresses, bootstrap/join discovery, restart and resume, churn, unreachable peers, late replies, retries, and backpressure.
- Keep discovery bounded by each node's real capabilities and contacts, while allowing referrals to grow the graph without a global directory or small hop budget.

## Later human and adversarial layers

- Punt ownership, abandoned or free-roaming agents, and claiming/reassignment. Later add human workflows for curating and growing private knowledge.
- Continue assuming benign peers for now. Add defenses against persistent bad answers, spam, fake identities, collusion, and privacy leaks only after the open network exists.

## Harness cleanup

- Ablate tracing to a tiny local JSONL log of receive, call, reply, routing-change, and return events. Compare it with an optional `/log` view or external HTTP tracing while keeping `POST /ask` the only required protocol.
