import { describe, expect, test } from "bun:test"

import {
  applySuccessfulPath,
  choosePeer,
  createFixture,
  createRandom,
  createScratch,
  runExperiment,
  runQuery,
  type MutableWorld,
  type Query,
  type SimulatedNode,
  type SimulationConfig,
} from "../evals/routing-simulation.ts"

const smallConfig: SimulationConfig = {
  factCacheCapacity: 4,
  initialPeerCount: 3,
  nodeCount: 256,
  peerCapacity: 5,
  probeFactsPerTopic: 4,
  probeQueryCount: 80,
  sourceFactsPerNode: 2,
  topicCount: 4,
  trainFactsPerTopic: 8,
  trainQueryCount: 200,
}

describe("abstract routing simulation", () => {
  test("credits immediate callees and only discovers the terminal provider", () => {
    const world = manualWorld([
      node(0, [peer(1, 1), peer(3)]),
      node(1, [peer(2)]),
      node(2, [], [{ answerId: 71, factId: 0 }]),
      node(3, [peer(0)]),
    ])
    world.config.peerCapacity = 2

    const outcome = runQuery(
      world,
      { factId: 0, originNodeId: 0, topicId: 0 },
      {
        mutate: true,
        policy: "hard-choice",
        random: createRandom(1),
        scoreMode: "topic",
        scratch: createScratch(4),
      },
    )
    const origin = required(world.nodes, 0)
    const intermediary = required(world.nodes, 1)
    const peerOne = required(
      origin.peers.filter((memory) => memory.nodeId === 1),
      0,
    )
    const peerTwo = required(
      origin.peers.filter((memory) => memory.nodeId === 2),
      0,
    )

    expect(outcome.path).toEqual([0, 1, 2])
    expect(outcome.discoveries).toBe(1)
    expect(outcome.peerEvictions).toBe(1)
    expect(origin.peers.map((memory) => memory.nodeId).sort((left, right) => left - right)).toEqual([
      1, 2,
    ])
    expect(peerOne.winsByTopic).toEqual([2])
    expect(peerTwo.winsByTopic).toEqual([0])
    expect(required(intermediary.peers, 0).winsByTopic).toEqual([1])
    expect(origin.cachedFacts.map((fact) => fact.factId)).toEqual([0])
    expect(intermediary.cachedFacts.map((fact) => fact.factId)).toEqual([0])
  })

  test("a miss terminates at a cycle without learning", () => {
    const world = manualWorld([node(0, [peer(1)]), node(1, [peer(0)])])
    const before = structuredClone(world.nodes)
    const query: Query = { factId: 0, originNodeId: 0, topicId: 0 }

    const outcome = runQuery(world, query, {
      mutate: true,
      policy: "weighted",
      random: createRandom(1),
      scoreMode: "topic",
      scratch: createScratch(2),
    })

    expect(outcome.answerKind).toBeNull()
    expect(outcome.path).toEqual([0, 1])
    expect(world.nodes).toEqual(before)
  })

  test("can learn a successful route without caching the answer", () => {
    const world = manualWorld([
      node(0, [peer(1)]),
      node(1, [], [{ answerId: 71, factId: 0 }]),
    ])
    world.config.factCacheCapacity = 0

    const outcome = runQuery(
      world,
      { factId: 0, originNodeId: 0, topicId: 0 },
      {
        mutate: true,
        policy: "weighted",
        random: createRandom(4),
        scoreMode: "topic",
        scratch: createScratch(2),
      },
    )

    expect(outcome.providerNodeId).toBe(1)
    expect(required(world.nodes, 0).cachedFacts).toEqual([])
    expect(required(required(world.nodes, 0).peers, 0).winsByTopic).toEqual([1])
  })

  test("evicts the least recently used learned fact at capacity", () => {
    const world = manualWorld([
      node(0, [peer(1), peer(2), peer(3)]),
      node(1, [], [{ answerId: 71, factId: 0 }]),
      node(2, [], [{ answerId: 72, factId: 1 }]),
      node(3, [], [{ answerId: 73, factId: 2 }]),
    ])
    world.config.factCacheCapacity = 2
    world.config.peerCapacity = 3
    world.facts = [
      { answerId: 71, partition: "train", topicId: 0 },
      { answerId: 72, partition: "train", topicId: 0 },
      { answerId: 73, partition: "train", topicId: 0 },
    ]

    world.tick = 1
    applySuccessfulPath(world, [0, 1], { factId: 0, originNodeId: 0, topicId: 0 }, 71)
    world.tick = 2
    applySuccessfulPath(world, [0, 2], { factId: 1, originNodeId: 0, topicId: 0 }, 72)
    world.tick = 3
    runQuery(
      world,
      { factId: 0, originNodeId: 0, topicId: 0 },
      {
        mutate: true,
        policy: "uniform",
        random: createRandom(2),
        scoreMode: "topic",
        scratch: createScratch(4),
      },
    )
    world.tick = 4
    applySuccessfulPath(world, [0, 3], { factId: 2, originNodeId: 0, topicId: 0 }, 73)

    expect(
      required(world.nodes, 0).cachedFacts
        .map((fact) => fact.factId)
        .sort((left, right) => left - right),
    ).toEqual([0, 2])
  })

  test("weighted routing samples in proportion to one plus wins", () => {
    const source = node(0, [peer(1, 0), peer(2, 2)])
    const random = createRandom(12)
    const visited = new Uint32Array(3)
    let first = 0
    let second = 0

    for (let index = 0; index < 4_000; index += 1) {
      const selected = choosePeer(source, 0, "weighted", "topic", visited, 1, random)
      if (selected?.nodeId === 1) first += 1
      if (selected?.nodeId === 2) second += 1
    }

    expect(first).toBeGreaterThan(900)
    expect(first).toBeLessThan(1_100)
    expect(second).toBe(4_000 - first)
  })

  test("rejects an answer that differs from hidden truth", () => {
    const world = manualWorld([node(0, [], [{ answerId: 999, factId: 0 }])])
    expect(() =>
      runQuery(
        world,
        { factId: 0, originNodeId: 0, topicId: 0 },
        {
          mutate: true,
          policy: "uniform",
          random: createRandom(1),
          scoreMode: "topic",
          scratch: createScratch(1),
        },
      ),
    ).toThrow("returned the wrong answer")
  })

  test("replays the same seeded experiment exactly", () => {
    expect(runExperiment(smallConfig, [3])).toEqual(runExperiment(smallConfig, [3]))
  })

  test("keeps uniform routing identical in matched signal and null worlds", () => {
    const report = runExperiment(smallConfig, [7])
    const signal = required(
      report.runs.filter(
        (run) => run.policy === "uniform" && run.worldKind === "signal",
      ),
      0,
    )
    const nullWorld = required(
      report.runs.filter(
        (run) => run.policy === "uniform" && run.worldKind === "null",
      ),
      0,
    )

    expect({ ...signal, worldKind: "null" }).toEqual(nullWorld)
  })

  test("builds seen probes only from facts that appeared in training", () => {
    const fixture = createFixture({ ...smallConfig, trainQueryCount: 1 }, 5, "signal")
    const trainedFactIds = new Set(fixture.trainQueries.map((query) => query.factId))
    const seenFactIds = new Set(fixture.seenQueries.map((query) => query.factId))

    expect(trainedFactIds.size).toBe(1)
    expect(seenFactIds).toEqual(trainedFactIds)
  })

  test("rejects a fixture when no node can originate a nonlocal query", () => {
    const saturatedConfig: SimulationConfig = {
      ...smallConfig,
      initialPeerCount: 1,
      nodeCount: 2,
      peerCapacity: 1,
      probeFactsPerTopic: 1,
      sourceFactsPerNode: 2,
      topicCount: 1,
      trainFactsPerTopic: 1,
    }

    expect(() => createFixture(saturatedConfig, 8, "signal")).toThrow(
      "Every node already privately knows fact",
    )
  })
})

function manualWorld(nodes: SimulatedNode[]): MutableWorld {
  return {
    config: {
      ...smallConfig,
      initialPeerCount: 1,
      nodeCount: nodes.length,
      peerCapacity: 2,
      probeFactsPerTopic: 1,
      sourceFactsPerNode: 1,
      topicCount: 1,
      trainFactsPerTopic: 1,
    },
    evictionRandom: createRandom(9),
    facts: [{ answerId: 71, partition: "train", topicId: 0 }],
    nodes,
    tick: 1,
  }
}

function node(
  id: number,
  peers: ReturnType<typeof peer>[],
  privateFacts: SimulatedNode["privateFacts"] = [],
): SimulatedNode {
  return { cachedFacts: [], id, peers, privateFacts }
}

function peer(nodeId: number, wins = 0): SimulatedNode["peers"][number] {
  return { lastUsefulAt: 0, learnedAt: 0, nodeId, winsByTopic: [wins] }
}

function required<T>(values: T[], index: number): T {
  const value = values[index]
  if (value === undefined) throw new Error(`Missing test value at ${index}`)
  return value
}
