# Abstract routing exploration

Run on 2026-08-18 with 10,000 fixed nodes, 20,000 training questions, 2,048
seen-fact probes, 2,048 held-out-fact probes, and 12 matched seeds.

## Model

- Each exact fact belongs to one of eight topics and has immutable source holders.
- A node remembers a bounded peer list, per-topic success counts for each peer, and a
  bounded LRU cache of learned facts.
- One question follows one non-repeating path. A node either answers or selects one
  unvisited peer. The path therefore ends naturally at an answer or dead end.
- A verified answer credits each caller's immediate callee once. All callers cache the
  answer and may remember the terminal provider, but newly discovered providers start
  with zero direct credit.
- Weighted routing samples peers in proportion to `1 + successes(peer, topic)`.
  Uniform routing ignores counts. Hard choice always selects a maximum-count peer.
- The signal world gives source nodes coherent topic portfolios. Its matched null world
  preserves fact IDs, holders, topology, capacity, and questions while permuting topic
  labels. Uniform routing produced identical core results in every signal/null seed.

Every returned answer is checked against hidden truth. The simulator throws on a wrong
answer, so the meaningful result here is resolution rate, not conditional accuracy.
Competing false claims and node fission are not modeled yet.

`@128` means the exact answer was found within 128 calls. It is measured after the fact;
nodes themselves have no timeout. Intervals below are exploratory paired 95% t intervals
over 12 seeds.

## Main result: eight peers, eight cached facts

| Policy | Late train @128 | Seen @128 | Held-out @128 | Eventual held-out | Calls / held-out answer |
| --- | ---: | ---: | ---: | ---: | ---: |
| Uniform | 68.00% | 77.30% | 44.34% | 99.20% | 207.5 |
| Hard choice | 54.39% | 63.42% | 46.50% | 98.42% | 192.8 |
| Weighted | 78.29% | 85.75% | 46.50% | 99.90% | 202.6 |

Weighted routing beat uniform by 10.29 points on late training questions
`[9.45, 11.13]` and 2.16 points on unseen facts `[1.07, 3.24]`. Hard choice
was 13.62 points worse than uniform on late training `[-14.69, -12.55]`.
Success counts contain useful signal, but removing exploration causes early lock-in.

On the same frozen weighted-trained state, using the learned weights rather than choosing
uniformly improved held-out @128 by 2.07 points `[1.16, 2.99]` and saved 10.1 calls per
answer `[5.2, 15.0]`. This isolates useful score learning from topology differences caused
by training under different policies.

## Cache ablation: eight peers, no learned facts

| Policy | Late train @128 | Seen @128 | Held-out @128 | Eventual held-out | Calls / held-out answer |
| --- | ---: | ---: | ---: | ---: | ---: |
| Uniform | 50.61% | 52.21% | 43.40% | 98.73% | 212.5 |
| Hard choice | 46.63% | 47.12% | 46.35% | 98.12% | 190.8 |
| Weighted | 52.29% | 52.61% | 46.68% | 99.77% | 202.0 |

Caching supplied an additional 8.61-point weighted-over-uniform gain on late training
questions `[7.51, 9.71]` and 8.05 points on seen probes `[6.44, 9.65]`.
It accounts for most repeat-question acceleration.

Routing learning still worked without cached answers. Weighted beat uniform by 3.27
points on held-out @128 `[2.27, 4.27]`. On the same weighted-trained state, weighted
selection beat uniform selection by 4.41 points `[3.26, 5.57]` and saved 15.6 calls per
answer `[10.1, 21.1]`.

## Bounded peer memory

These are weighted-policy results with an eight-fact cache.

| Peer capacity | Late train @128 | Held-out @128 | Eventual held-out | Dead end | Calls / held-out answer |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 65.84% | 48.18% | 94.68% | 5.32% | 167.5 |
| 8 | 78.29% | 46.50% | 99.90% | 0.10% | 202.6 |
| 16 | 75.33% | 45.33% | 99.98% | 0.02% | 214.6 |

Four peers resolve some questions quickly but lose reachability. Sixteen nearly eliminates
dead ends but wanders longer and does not improve fast resolution. Eight is a reasonable
first default, not a universal optimum.

With only four peers, uniform routing dead-ended on 32.03% of held-out questions while
weighted routing dead-ended on 5.32%. Reinforcement helps preserve useful links under a
tight memory bound.

## Specialization is not established yet

Weighted held-out @128 was only 0.91 points better in the signal world than the matched
null world `[-0.21, 2.03]`; without caching the surplus was 0.94 points
`[-0.24, 2.13]`. Both intervals cross zero.

On the same state, topic-specific scores provided only 0.64 points more signal-over-null
benefit than scores collapsed across topics `[-0.55, 1.83]`; without caching it was 1.28
points `[-0.14, 2.69]`. The network demonstrably learns generally useful routes, but this
run does not demonstrate semantic topic specialization.

Raw topic-concentration diagnostics are deliberately omitted: with 10,000 nodes and
sparse observations, chance makes many lightly sampled nodes appear perfectly
specialized. The held-out signal/null and topic/global ablations are the specialization
tests.

## Other observations

- Return-path learning is aggressive. In the eight-peer weighted run, a training question
  averaged 90.1 calls, 88.6 provider discoveries, 86.6 peer evictions, and 86.1 fact-cache
  evictions. The tables stay almost full. Transitive provider attribution works, but its
  churn is now a concrete target for a later ablation.
- The weighted eight-peer state ended with 7.94 remembered peers per node; 65.10% were
  learned rather than seeded. Its seen probes answered from cache 62.26% of the time.
- Without caching, weighted training averaged 169.2 calls. Distributed fact copies nearly
  halve repeated-work search, even with the same immutable source knowledge.

## Archive

The one-shot simulator and its tests were removed after this exploration so they would
not become permanent product machinery. Their exact source remains available in Git
commit `870a0c1`.
