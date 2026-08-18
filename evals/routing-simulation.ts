export type RoutingPolicy = "hard-choice" | "uniform" | "weighted"
export type ScoreMode = "global" | "topic"
export type WorldKind = "null" | "signal"

export type SimulationConfig = {
  factCacheCapacity: number
  initialPeerCount: number
  nodeCount: number
  peerCapacity: number
  probeFactsPerTopic: number
  probeQueryCount: number
  sourceFactsPerNode: number
  topicCount: number
  trainFactsPerTopic: number
  trainQueryCount: number
}

type FactPartition = "probe" | "train"

export type FactTruth = {
  answerId: number
  partition: FactPartition
  topicId: number
}

export type KnownFact = {
  answerId: number
  factId: number
}

export type CachedFact = KnownFact & {
  lastUsedAt: number
}

export type PeerMemory = {
  lastUsefulAt: number
  learnedAt: number
  nodeId: number
  winsByTopic: number[]
}

export type SimulatedNode = {
  cachedFacts: CachedFact[]
  id: number
  peers: PeerMemory[]
  privateFacts: KnownFact[]
}

export type Query = {
  factId: number
  originNodeId: number
  topicId: number
}

type SeedNode = {
  peerIds: number[]
  privateFacts: KnownFact[]
}

export type SimulationFixture = {
  facts: FactTruth[]
  heldoutQueries: Query[]
  nodes: SeedNode[]
  seenQueries: Query[]
  trainQueries: Query[]
  worldKind: WorldKind
}

export type AnswerKind = "cache" | "source"

export type QueryOutcome = {
  answerKind: AnswerKind | null
  cacheEvictions: number
  calls: number
  discoveries: number
  discoveredPeerCalls: number
  path: number[]
  peerEvictions: number
  providerNodeId: number | null
}

export type BatchSummary = {
  answerRate: number
  answerRateWithin128Calls: number
  cacheAnswerRate: number
  cacheEvictionsPerQuery: number
  callsMean: number
  callsPerAnswer: number
  deadEndRate: number
  discoveriesPerQuery: number
  discoveredPeerCallShare: number
  peerEvictionsPerQuery: number
}

export type StateSummary = {
  discoveredPeerShare: number
  meanCachedFacts: number
  meanPeers: number
}

export type SimulationRun = {
  heldoutProbe: BatchSummary
  heldoutProbeGlobalScores: BatchSummary
  heldoutProbeUniformSelection: BatchSummary
  policy: RoutingPolicy
  seenProbe: BatchSummary
  state: StateSummary
  train: BatchSummary
  trainEarly: BatchSummary
  trainLate: BatchSummary
  worldKind: WorldKind
}

export type ExperimentRun = SimulationRun & {
  seed: number
}

export type MetricStats = {
  maximum: number
  mean: number
  median: number
  minimum: number
}

export type AggregateRun = {
  heldoutCallsPerAnswer: MetricStats
  heldoutCallsPerAnswerUsingGlobalScores: MetricStats
  heldoutSuccessWithin128Calls: MetricStats
  heldoutSuccessWithin128CallsUsingGlobalScores: MetricStats
  heldoutSuccessWithin128CallsUsingUniformSelection: MetricStats
  policy: RoutingPolicy
  seenSuccessWithin128Calls: MetricStats
  trainEarlySuccessWithin128Calls: MetricStats
  trainLateSuccessWithin128Calls: MetricStats
  worldKind: WorldKind
}

export type ExperimentReport = {
  aggregates: AggregateRun[]
  config: SimulationConfig
  runs: ExperimentRun[]
  seeds: number[]
}

export type Random = {
  state: number
}

export type QueryScratch = {
  generation: number
  visitedAt: Uint32Array
}

export type MutableWorld = {
  config: SimulationConfig
  evictionRandom: Random
  facts: FactTruth[]
  nodes: SimulatedNode[]
  tick: number
}

export type QueryOptions = {
  mutate: boolean
  policy: RoutingPolicy
  random: Random
  scoreMode: ScoreMode
  scratch: QueryScratch
}

type SuccessfulPathChanges = {
  cacheEvictions: number
  discoveries: number
  peerEvictions: number
}

const defaultConfig: SimulationConfig = {
  factCacheCapacity: 8,
  initialPeerCount: 4,
  nodeCount: 10_000,
  peerCapacity: 8,
  probeFactsPerTopic: 32,
  probeQueryCount: 2_048,
  sourceFactsPerNode: 4,
  topicCount: 8,
  trainFactsPerTopic: 64,
  trainQueryCount: 20_000,
}

const policies: RoutingPolicy[] = ["uniform", "hard-choice", "weighted"]
const worldKinds: WorldKind[] = ["signal", "null"]

if (import.meta.main) {
  try {
    const { config, json, seeds } = parseArguments(process.argv.slice(2))
    const report = runExperiment(config, seeds)
    if (json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      printReport(report)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export function runExperiment(config: SimulationConfig, seeds: number[]): ExperimentReport {
  validateConfig(config)
  validateSeeds(seeds)

  const runs: ExperimentRun[] = []
  for (const seed of seeds) {
    for (const worldKind of worldKinds) {
      const fixture = createFixture(config, seed, worldKind)
      for (const policy of policies) {
        runs.push({ ...runSimulation(config, fixture, policy, seed), seed })
      }
    }
  }

  return { aggregates: aggregateRuns(runs), config, runs, seeds }
}

export function createFixture(
  config: SimulationConfig,
  seed: number,
  worldKind: WorldKind,
): SimulationFixture {
  validateConfig(config)

  const signalFacts = createFacts(config)
  const facts =
    worldKind === "signal"
      ? signalFacts
      : permuteFactTopics(signalFacts, createRandom(mixSeed(seed, 11)))
  const sourceRandom = createRandom(mixSeed(seed, 17))
  const homeTopics = createBalancedHomeTopics(config, sourceRandom)
  const nodes = createSeedNodes(config, signalFacts, facts, homeTopics, sourceRandom)
  addInitialPeers(nodes, config, createRandom(mixSeed(seed, 23)))
  validateFixture(config, facts, nodes)

  const heldoutQueries = createQueries(
    facts,
    nodes,
    "probe",
    config.probeQueryCount,
    createRandom(mixSeed(seed, 29)),
  )
  const trainQueries = createQueries(
    facts,
    nodes,
    "train",
    config.trainQueryCount,
    createRandom(mixSeed(seed, 31)),
  )
  const seenFactIds = [...new Set(trainQueries.map((query) => query.factId))]
  return {
    facts,
    heldoutQueries,
    nodes,
    seenQueries: createQueriesForFacts(
      facts,
      nodes,
      seenFactIds,
      config.probeQueryCount,
      createRandom(mixSeed(seed, 33)),
    ),
    trainQueries,
    worldKind,
  }
}

export function runSimulation(
  config: SimulationConfig,
  fixture: SimulationFixture,
  policy: RoutingPolicy,
  seed: number,
): SimulationRun {
  validateFixture(config, fixture.facts, fixture.nodes)
  const world = instantiateWorld(config, fixture, mixSeed(seed, 37))
  const scratch = createScratch(config.nodeCount)
  const trainOutcomes: QueryOutcome[] = []
  const evictionSeed = mixSeed(seed, 37)
  const routeSeed = mixSeed(seed, 41)
  for (const [queryIndex, query] of fixture.trainQueries.entries()) {
    world.tick += 1
    world.evictionRandom = createRandom(mixSeed(evictionSeed, queryIndex + 1))
    trainOutcomes.push(
      runQuery(world, query, {
        mutate: true,
        policy,
        random: createRandom(mixSeed(routeSeed, queryIndex + 1)),
        scoreMode: "topic",
        scratch,
      }),
    )
  }

  const windowSize = Math.max(1, Math.floor(trainOutcomes.length / 5))
  const seenProbe = runProbe(
    world,
    fixture.seenQueries,
    policy,
    "topic",
    mixSeed(seed, 43),
  )
  const heldoutProbe = runProbe(
    world,
    fixture.heldoutQueries,
    policy,
    "topic",
    mixSeed(seed, 47),
  )
  const heldoutProbeGlobalScores = runProbe(
    world,
    fixture.heldoutQueries,
    policy,
    "global",
    mixSeed(seed, 47),
  )
  const heldoutProbeUniformSelection = runProbe(
    world,
    fixture.heldoutQueries,
    "uniform",
    "topic",
    mixSeed(seed, 47),
  )

  return {
    heldoutProbe: summarizeBatch(heldoutProbe),
    heldoutProbeGlobalScores: summarizeBatch(heldoutProbeGlobalScores),
    heldoutProbeUniformSelection: summarizeBatch(heldoutProbeUniformSelection),
    policy,
    seenProbe: summarizeBatch(seenProbe),
    state: summarizeState(world),
    train: summarizeBatch(trainOutcomes),
    trainEarly: summarizeBatch(trainOutcomes.slice(0, windowSize)),
    trainLate: summarizeBatch(trainOutcomes.slice(-windowSize)),
    worldKind: fixture.worldKind,
  }
}

export function runQuery(
  world: MutableWorld,
  query: Query,
  options: QueryOptions,
): QueryOutcome {
  const truth = world.facts[query.factId]
  if (truth === undefined) throw new Error(`Unknown fact ${query.factId}`)
  if (truth.topicId !== query.topicId) throw new Error("Query topic does not match its fact")
  if (query.originNodeId < 0 || query.originNodeId >= world.nodes.length) {
    throw new Error(`Unknown origin node ${query.originNodeId}`)
  }

  const generation = nextGeneration(options.scratch)
  const path = [query.originNodeId]
  options.scratch.visitedAt[query.originNodeId] = generation
  let currentNodeId = query.originNodeId
  let discoveredPeerCalls = 0

  for (;;) {
    const node = requireNode(world.nodes, currentNodeId)
    const answer = findAnswer(node, query.factId, options.mutate ? world.tick : null)
    if (answer !== null) {
      if (answer.answerId !== truth.answerId) {
        throw new Error(`Node ${node.id} returned the wrong answer for fact ${query.factId}`)
      }
      const changes = options.mutate
        ? applySuccessfulPath(world, path, query, answer.answerId)
        : { cacheEvictions: 0, discoveries: 0, peerEvictions: 0 }
      return {
        answerKind: answer.kind,
        cacheEvictions: changes.cacheEvictions,
        calls: path.length - 1,
        discoveries: changes.discoveries,
        discoveredPeerCalls,
        path,
        peerEvictions: changes.peerEvictions,
        providerNodeId: currentNodeId,
      }
    }

    const peer = choosePeer(
      node,
      query.topicId,
      options.policy,
      options.scoreMode,
      options.scratch.visitedAt,
      generation,
      options.random,
    )
    if (peer === null) return missOutcome(path, discoveredPeerCalls)

    if (peer.learnedAt > 0) discoveredPeerCalls += 1
    currentNodeId = peer.nodeId
    options.scratch.visitedAt[currentNodeId] = generation
    path.push(currentNodeId)
  }
}

export function choosePeer(
  node: SimulatedNode,
  topicId: number,
  policy: RoutingPolicy,
  scoreMode: ScoreMode,
  visitedAt: Uint32Array,
  generation: number,
  random: Random,
): PeerMemory | null {
  switch (policy) {
    case "uniform": {
      let candidateCount = 0
      for (const peer of node.peers) {
        if (visitedAt[peer.nodeId] !== generation) candidateCount += 1
      }
      if (candidateCount === 0) return null
      let target = randomInteger(random, candidateCount)
      for (const peer of node.peers) {
        if (visitedAt[peer.nodeId] === generation) continue
        if (target === 0) return peer
        target -= 1
      }
      throw new Error("Uniform peer selection lost its candidate")
    }
    case "hard-choice": {
      let bestScore = -1
      let tieCount = 0
      for (const peer of node.peers) {
        if (visitedAt[peer.nodeId] === generation) continue
        const score = peerScore(peer, topicId, scoreMode)
        if (score > bestScore) {
          bestScore = score
          tieCount = 1
        } else if (score === bestScore) {
          tieCount += 1
        }
      }
      if (tieCount === 0) return null
      let target = randomInteger(random, tieCount)
      for (const peer of node.peers) {
        if (visitedAt[peer.nodeId] === generation) continue
        if (peerScore(peer, topicId, scoreMode) !== bestScore) continue
        if (target === 0) return peer
        target -= 1
      }
      throw new Error("Hard-choice peer selection lost its candidate")
    }
    case "weighted": {
      let totalWeight = 0
      for (const peer of node.peers) {
        if (visitedAt[peer.nodeId] === generation) {
          continue
        }
        totalWeight += 1 + peerScore(peer, topicId, scoreMode)
      }
      if (totalWeight === 0) return null
      let target = randomFloat(random) * totalWeight
      for (const peer of node.peers) {
        if (visitedAt[peer.nodeId] === generation) continue
        target -= 1 + peerScore(peer, topicId, scoreMode)
        if (target < 0) return peer
      }
      throw new Error("Weighted peer selection lost its candidate")
    }
  }
}

export function applySuccessfulPath(
  world: MutableWorld,
  path: number[],
  query: Query,
  answerId: number,
): SuccessfulPathChanges {
  const providerNodeId = path.at(-1)
  if (providerNodeId === undefined) throw new Error("A successful path cannot be empty")

  let cacheEvictions = 0
  let discoveries = 0
  let peerEvictions = 0
  for (let index = path.length - 2; index >= 0; index -= 1) {
    const callerNodeId = path[index]
    const childNodeId = path[index + 1]
    if (callerNodeId === undefined || childNodeId === undefined) {
      throw new Error("Successful path edge is incomplete")
    }
    const caller = requireNode(world.nodes, callerNodeId)
    const child = findPeer(caller, childNodeId)
    if (child === null) throw new Error("Successful path used a forgotten peer")
    child.winsByTopic[query.topicId] = requireNumberAt(child.winsByTopic, query.topicId) + 1
    child.lastUsefulAt = world.tick

    if (cacheFact(caller, query.factId, answerId, world.tick, world.config.factCacheCapacity)) {
      cacheEvictions += 1
    }
    const peerChange = learnProvider(
      caller,
      providerNodeId,
      childNodeId,
      world.tick,
      world.config,
      world.evictionRandom,
    )
    discoveries += peerChange.discovered ? 1 : 0
    peerEvictions += peerChange.evicted ? 1 : 0
  }
  return { cacheEvictions, discoveries, peerEvictions }
}

function parseArguments(arguments_: string[]): {
  config: SimulationConfig
  json: boolean
  seeds: number[]
} {
  const config = { ...defaultConfig }
  let json = false
  let seedCount = 12

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    switch (argument) {
      case "--json":
        json = true
        break
      case "--nodes":
        config.nodeCount = parsePositiveInteger(arguments_[index + 1], "--nodes")
        index += 1
        break
      case "--queries":
        config.trainQueryCount = parsePositiveInteger(arguments_[index + 1], "--queries")
        index += 1
        break
      case "--fact-cache":
        config.factCacheCapacity = parseNonnegativeInteger(
          arguments_[index + 1],
          "--fact-cache",
        )
        index += 1
        break
      case "--initial-peers":
        config.initialPeerCount = parsePositiveInteger(
          arguments_[index + 1],
          "--initial-peers",
        )
        index += 1
        break
      case "--peer-capacity":
        config.peerCapacity = parsePositiveInteger(
          arguments_[index + 1],
          "--peer-capacity",
        )
        index += 1
        break
      case "--probe-queries":
        config.probeQueryCount = parsePositiveInteger(
          arguments_[index + 1],
          "--probe-queries",
        )
        index += 1
        break
      case "--seeds":
        seedCount = parsePositiveInteger(arguments_[index + 1], "--seeds")
        index += 1
        break
      case "--source-facts":
        config.sourceFactsPerNode = parsePositiveInteger(
          arguments_[index + 1],
          "--source-facts",
        )
        index += 1
        break
      case undefined:
        throw new Error(usage())
      default:
        throw new Error(`Unknown argument: ${argument}\n${usage()}`)
    }
  }

  const seeds = Array.from({ length: seedCount }, (_, index) => index + 1)
  return { config, json, seeds }
}

function usage(): string {
  return [
    "Usage: bun run eval:routing [options]",
    "",
    "Options: --nodes N --queries N --probe-queries N --seeds N --initial-peers N",
    "         --peer-capacity N --fact-cache N --source-facts N --json",
    "",
    "Defaults: 10000 nodes, 20000 training queries, 12 seeds.",
  ].join("\n")
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${flag} requires an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`)
  }
  return parsed
}

function parseNonnegativeInteger(value: string | undefined, flag: string): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${flag} requires an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a nonnegative integer`)
  }
  return parsed
}

function validateConfig(config: SimulationConfig): void {
  for (const [label, value] of Object.entries(config)) {
    const minimum = label === "factCacheCapacity" ? 0 : 1
    if (!Number.isSafeInteger(value) || value < minimum) {
      const qualifier = minimum === 0 ? "nonnegative" : "positive"
      throw new Error(`${label} must be a ${qualifier} integer`)
    }
  }
  if (config.topicCount > config.nodeCount) throw new Error("topicCount cannot exceed nodeCount")
  if (config.initialPeerCount >= config.nodeCount) {
    throw new Error("initialPeerCount must be smaller than nodeCount")
  }
  if (config.initialPeerCount > config.peerCapacity) {
    throw new Error("initialPeerCount cannot exceed peerCapacity")
  }
  const factCount = config.topicCount * (config.trainFactsPerTopic + config.probeFactsPerTopic)
  if (config.nodeCount * config.sourceFactsPerNode < factCount) {
    throw new Error("There are not enough private fact slots to keep every fact available")
  }
  if (config.sourceFactsPerNode > config.trainFactsPerTopic + config.probeFactsPerTopic) {
    throw new Error("sourceFactsPerNode exceeds the distinct facts in one topic")
  }
  const nodesInSmallestTopic = Math.floor(config.nodeCount / config.topicCount)
  const factsPerTopic = config.trainFactsPerTopic + config.probeFactsPerTopic
  if (nodesInSmallestTopic * config.sourceFactsPerNode < factsPerTopic) {
    throw new Error("The smallest topic group lacks private fact capacity")
  }
}

function validateSeeds(seeds: number[]): void {
  if (seeds.length === 0) throw new Error("At least one seed is required")
  const uniqueSeeds = new Set<number>()
  for (const seed of seeds) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new Error("Seeds must be unsigned 32-bit integers")
    }
    if (uniqueSeeds.has(seed)) throw new Error(`Duplicate seed ${seed}`)
    uniqueSeeds.add(seed)
  }
}

function createFacts(config: SimulationConfig): FactTruth[] {
  const facts: FactTruth[] = []
  for (let topicId = 0; topicId < config.topicCount; topicId += 1) {
    for (let index = 0; index < config.trainFactsPerTopic; index += 1) {
      facts.push({ answerId: answerForFact(facts.length), partition: "train", topicId })
    }
    for (let index = 0; index < config.probeFactsPerTopic; index += 1) {
      facts.push({ answerId: answerForFact(facts.length), partition: "probe", topicId })
    }
  }
  return facts
}

function permuteFactTopics(facts: FactTruth[], random: Random): FactTruth[] {
  const permuted = facts.map((fact) => ({ ...fact }))
  for (const partition of ["train", "probe"] as const) {
    const factIds: number[] = []
    const topics: number[] = []
    for (const [factId, fact] of facts.entries()) {
      if (fact.partition !== partition) continue
      factIds.push(factId)
      topics.push(fact.topicId)
    }
    shuffle(topics, random)
    for (const [index, factId] of factIds.entries()) {
      const topicId = topics[index]
      if (topicId === undefined) throw new Error("Topic permutation lost a topic")
      const fact = permuted[factId]
      if (fact === undefined) throw new Error("Topic permutation lost a fact")
      fact.topicId = topicId
    }
  }
  return permuted
}

function answerForFact(factId: number): number {
  return Math.imul(factId + 1, 2_654_435_761) >>> 0
}

function createBalancedHomeTopics(config: SimulationConfig, random: Random): number[] {
  const topics = Array.from({ length: config.nodeCount }, (_, nodeId) => nodeId % config.topicCount)
  shuffle(topics, random)
  return topics
}

function createSeedNodes(
  config: SimulationConfig,
  signalFacts: FactTruth[],
  actualFacts: FactTruth[],
  homeTopics: number[],
  random: Random,
): SeedNode[] {
  const nodes: SeedNode[] = Array.from({ length: config.nodeCount }, () => ({
    peerIds: [],
    privateFacts: [],
  }))
  const factIdsBySignalTopic = groupFactIdsByTopic(signalFacts, config.topicCount)
  const nodeIdsByHomeTopic: number[][] = Array.from({ length: config.topicCount }, () => [])
  for (const [nodeId, topicId] of homeTopics.entries()) {
    const topicNodes = nodeIdsByHomeTopic[topicId]
    if (topicNodes === undefined) throw new Error("Home topic is out of range")
    topicNodes.push(nodeId)
  }

  for (let topicId = 0; topicId < config.topicCount; topicId += 1) {
    const topicNodes = requireArrayAt(nodeIdsByHomeTopic, topicId).slice()
    const topicFacts = requireArrayAt(factIdsBySignalTopic, topicId)
    shuffle(topicNodes, random)
    if (topicNodes.length * config.sourceFactsPerNode < topicFacts.length) {
      throw new Error(`Topic ${topicId} lacks private fact capacity`)
    }
    for (const [index, factId] of topicFacts.entries()) {
      const nodeId = topicNodes[index % topicNodes.length]
      if (nodeId === undefined) throw new Error("Private fact assignment lost a node")
      addPrivateFact(requireNodeSeed(nodes, nodeId), factId, requireFact(actualFacts, factId))
    }
  }

  for (const [nodeId, seedNode] of nodes.entries()) {
    const topicId = homeTopics[nodeId]
    if (topicId === undefined) throw new Error("Private fact fill lost a home topic")
    const topicFacts = requireArrayAt(factIdsBySignalTopic, topicId)
    const candidates = topicFacts.filter(
      (factId) => !hasKnownFact(seedNode.privateFacts, factId),
    )
    shuffle(candidates, random)
    const needed = config.sourceFactsPerNode - seedNode.privateFacts.length
    if (candidates.length < needed) throw new Error("Private fact fill lacks candidates")
    for (let index = 0; index < needed; index += 1) {
      const factId = requireNumberAt(candidates, index)
      addPrivateFact(seedNode, factId, requireFact(actualFacts, factId))
    }
  }
  return nodes
}

function addPrivateFact(node: SeedNode, factId: number, truth: FactTruth): void {
  if (hasKnownFact(node.privateFacts, factId)) return
  node.privateFacts.push({ answerId: truth.answerId, factId })
}

function addInitialPeers(nodes: SeedNode[], config: SimulationConfig, random: Random): void {
  for (let nodeId = 0; nodeId < nodes.length; nodeId += 1) {
    const seed = requireNodeSeed(nodes, nodeId)
    addPeerId(seed.peerIds, (nodeId + 1) % nodes.length, nodeId)
    if (config.initialPeerCount > 1) {
      addPeerId(seed.peerIds, (nodeId - 1 + nodes.length) % nodes.length, nodeId)
    }
    while (seed.peerIds.length < config.initialPeerCount) {
      addPeerId(seed.peerIds, randomInteger(random, nodes.length), nodeId)
    }
  }
}

function addPeerId(peerIds: number[], peerId: number, selfId: number): void {
  if (peerId === selfId || peerIds.includes(peerId)) return
  peerIds.push(peerId)
}

function createQueries(
  facts: FactTruth[],
  nodes: SeedNode[],
  partition: FactPartition,
  queryCount: number,
  random: Random,
): Query[] {
  const factIds: number[] = []
  for (const [factId, fact] of facts.entries()) {
    if (fact.partition === partition) factIds.push(factId)
  }
  if (factIds.length === 0) throw new Error(`No ${partition} facts exist`)

  return createQueriesForFacts(facts, nodes, factIds, queryCount, random)
}

function createQueriesForFacts(
  facts: FactTruth[],
  nodes: SeedNode[],
  factIds: number[],
  queryCount: number,
  random: Random,
): Query[] {
  if (factIds.length === 0) throw new Error("No eligible query facts exist")
  const sourceNodeIdsByFact = createSourceNodeIdsByFact(facts.length, nodes)

  const order = factIds.slice()
  shuffle(order, random)
  const queries: Query[] = []
  for (let index = 0; index < queryCount; index += 1) {
    if (index > 0 && index % order.length === 0) shuffle(order, random)
    const factId = requireNumberAt(order, index % order.length)
    const originNodeId = chooseEligibleOrigin(
      requireArrayAt(sourceNodeIdsByFact, factId),
      nodes.length,
      random,
      factId,
    )
    queries.push({ factId, originNodeId, topicId: requireFact(facts, factId).topicId })
  }
  return queries
}

function createSourceNodeIdsByFact(factCount: number, nodes: SeedNode[]): number[][] {
  const sourceNodeIdsByFact: number[][] = Array.from({ length: factCount }, () => [])
  for (const [nodeId, node] of nodes.entries()) {
    for (const fact of node.privateFacts) {
      requireArrayAt(sourceNodeIdsByFact, fact.factId).push(nodeId)
    }
  }
  return sourceNodeIdsByFact
}

function chooseEligibleOrigin(
  sourceNodeIds: number[],
  nodeCount: number,
  random: Random,
  factId: number,
): number {
  const eligibleCount = nodeCount - sourceNodeIds.length
  if (eligibleCount <= 0) throw new Error(`Every node already privately knows fact ${factId}`)

  let originNodeId = randomInteger(random, eligibleCount)
  for (const sourceNodeId of sourceNodeIds) {
    if (sourceNodeId > originNodeId) break
    originNodeId += 1
  }
  return originNodeId
}

function validateFixture(config: SimulationConfig, facts: FactTruth[], nodes: SeedNode[]): void {
  const expectedFactCount =
    config.topicCount * (config.trainFactsPerTopic + config.probeFactsPerTopic)
  if (facts.length !== expectedFactCount) throw new Error("Fixture fact count is incorrect")
  if (nodes.length !== config.nodeCount) throw new Error("Fixture node count is incorrect")
  const sourceCounts = new Uint32Array(facts.length)
  const partitionTopicCounts = new Uint32Array(config.topicCount * 2)
  for (const fact of facts) {
    if (fact.topicId < 0 || fact.topicId >= config.topicCount) {
      throw new Error("Fixture fact topic is out of range")
    }
    const partitionOffset = fact.partition === "train" ? 0 : config.topicCount
    const countIndex = partitionOffset + fact.topicId
    partitionTopicCounts[countIndex] = requireNumberAt(partitionTopicCounts, countIndex) + 1
  }
  for (let topicId = 0; topicId < config.topicCount; topicId += 1) {
    if (requireNumberAt(partitionTopicCounts, topicId) !== config.trainFactsPerTopic) {
      throw new Error(`Topic ${topicId} has the wrong number of training facts`)
    }
    if (
      requireNumberAt(partitionTopicCounts, config.topicCount + topicId) !==
      config.probeFactsPerTopic
    ) {
      throw new Error(`Topic ${topicId} has the wrong number of probe facts`)
    }
  }
  for (const [nodeId, node] of nodes.entries()) {
    if (node.privateFacts.length !== config.sourceFactsPerNode) {
      throw new Error(`Node ${nodeId} has the wrong number of private facts`)
    }
    if (node.peerIds.length !== config.initialPeerCount) {
      throw new Error(`Node ${nodeId} has the wrong number of peers`)
    }
    if (new Set(node.privateFacts.map((fact) => fact.factId)).size !== node.privateFacts.length) {
      throw new Error(`Node ${nodeId} has duplicate private facts`)
    }
    for (const fact of node.privateFacts) {
      const truth = requireFact(facts, fact.factId)
      if (fact.answerId !== truth.answerId) throw new Error("Private fact answer is incorrect")
      sourceCounts[fact.factId] = requireNumberAt(sourceCounts, fact.factId) + 1
    }
    for (const peerId of node.peerIds) {
      if (peerId === nodeId) throw new Error("A node cannot know itself")
      if (peerId < 0 || peerId >= nodes.length) throw new Error("Peer ID is out of range")
    }
    if (new Set(node.peerIds).size !== node.peerIds.length) {
      throw new Error("Initial peer IDs must be unique")
    }
  }
  for (const [factId, count] of sourceCounts.entries()) {
    if (count === 0) throw new Error(`Fact ${factId} has no private source`)
    if (count === nodes.length) {
      throw new Error(`Every node already privately knows fact ${factId}`)
    }
  }
}

function instantiateWorld(
  config: SimulationConfig,
  fixture: SimulationFixture,
  evictionSeed: number,
): MutableWorld {
  return {
    config,
    evictionRandom: createRandom(evictionSeed),
    facts: fixture.facts,
    nodes: fixture.nodes.map((seed, id) => ({
      cachedFacts: [],
      id,
      peers: seed.peerIds.map((nodeId) => ({
        lastUsefulAt: 0,
        learnedAt: 0,
        nodeId,
        winsByTopic: Array.from({ length: config.topicCount }, () => 0),
      })),
      privateFacts: seed.privateFacts.map((fact) => ({ ...fact })),
    })),
    tick: 0,
  }
}

function runProbe(
  world: MutableWorld,
  queries: Query[],
  policy: RoutingPolicy,
  scoreMode: ScoreMode,
  seed: number,
): QueryOutcome[] {
  const scratch = createScratch(world.nodes.length)
  return queries.map((query, queryIndex) =>
    runQuery(world, query, {
      mutate: false,
      policy,
      random: createRandom(mixSeed(seed, queryIndex + 1)),
      scoreMode,
      scratch,
    }),
  )
}

export function createScratch(nodeCount: number): QueryScratch {
  return { generation: 0, visitedAt: new Uint32Array(nodeCount) }
}

function nextGeneration(scratch: QueryScratch): number {
  scratch.generation += 1
  if (scratch.generation === 0xffff_ffff) {
    scratch.visitedAt.fill(0)
    scratch.generation = 1
  }
  return scratch.generation
}

function findAnswer(
  node: SimulatedNode,
  factId: number,
  usedAt: number | null,
): { answerId: number; kind: AnswerKind } | null {
  for (const fact of node.privateFacts) {
    if (fact.factId === factId) return { answerId: fact.answerId, kind: "source" }
  }
  for (const fact of node.cachedFacts) {
    if (fact.factId !== factId) continue
    if (usedAt !== null) fact.lastUsedAt = usedAt
    return { answerId: fact.answerId, kind: "cache" }
  }
  return null
}

function missOutcome(
  path: number[],
  discoveredPeerCalls: number,
): QueryOutcome {
  return {
    answerKind: null,
    cacheEvictions: 0,
    calls: path.length - 1,
    discoveries: 0,
    discoveredPeerCalls,
    path,
    peerEvictions: 0,
    providerNodeId: null,
  }
}

function peerScore(peer: PeerMemory, topicId: number, scoreMode: ScoreMode): number {
  switch (scoreMode) {
    case "topic":
      return requireNumberAt(peer.winsByTopic, topicId)
    case "global": {
      let total = 0
      for (const wins of peer.winsByTopic) total += wins
      return total
    }
  }
}

function findPeer(node: SimulatedNode, peerNodeId: number): PeerMemory | null {
  for (const peer of node.peers) {
    if (peer.nodeId === peerNodeId) return peer
  }
  return null
}

function cacheFact(
  node: SimulatedNode,
  factId: number,
  answerId: number,
  tick: number,
  capacity: number,
): boolean {
  if (hasKnownFact(node.privateFacts, factId)) return false
  if (capacity === 0) return false
  for (const fact of node.cachedFacts) {
    if (fact.factId !== factId) continue
    if (fact.answerId !== answerId) throw new Error("Cached answers cannot conflict")
    fact.lastUsedAt = tick
    return false
  }

  let evicted = false
  if (node.cachedFacts.length >= capacity) {
    let victimIndex = 0
    for (let index = 1; index < node.cachedFacts.length; index += 1) {
      const candidate = requireArrayAt(node.cachedFacts, index)
      const victim = requireArrayAt(node.cachedFacts, victimIndex)
      if (candidate.lastUsedAt < victim.lastUsedAt) victimIndex = index
    }
    node.cachedFacts.splice(victimIndex, 1)
    evicted = true
  }
  node.cachedFacts.push({ answerId, factId, lastUsedAt: tick })
  return evicted
}

function learnProvider(
  node: SimulatedNode,
  providerNodeId: number,
  protectedPeerId: number,
  tick: number,
  config: SimulationConfig,
  random: Random,
): { discovered: boolean; evicted: boolean } {
  if (providerNodeId === node.id || findPeer(node, providerNodeId) !== null) {
    return { discovered: false, evicted: false }
  }

  let evicted = false
  if (node.peers.length >= config.peerCapacity) {
    const victimIndex = choosePeerVictim(node, protectedPeerId, random)
    if (victimIndex === null) return { discovered: false, evicted: false }
    node.peers.splice(victimIndex, 1)
    evicted = true
  }
  node.peers.push({
    lastUsefulAt: 0,
    learnedAt: tick,
    nodeId: providerNodeId,
    winsByTopic: Array.from({ length: config.topicCount }, () => 0),
  })
  return { discovered: true, evicted }
}

function choosePeerVictim(
  node: SimulatedNode,
  protectedPeerId: number,
  random: Random,
): number | null {
  let lowestWins = Number.POSITIVE_INFINITY
  let oldestUse = Number.POSITIVE_INFINITY
  const candidates: number[] = []
  for (const [index, peer] of node.peers.entries()) {
    if (peer.nodeId === protectedPeerId) continue
    let totalWins = 0
    for (const wins of peer.winsByTopic) totalWins += wins
    if (totalWins < lowestWins || (totalWins === lowestWins && peer.lastUsefulAt < oldestUse)) {
      lowestWins = totalWins
      oldestUse = peer.lastUsefulAt
      candidates.length = 0
      candidates.push(index)
    } else if (totalWins === lowestWins && peer.lastUsefulAt === oldestUse) {
      candidates.push(index)
    }
  }
  if (candidates.length === 0) return null
  return requireNumberAt(candidates, randomInteger(random, candidates.length))
}

function summarizeBatch(outcomes: QueryOutcome[]): BatchSummary {
  if (outcomes.length === 0) throw new Error("Cannot summarize an empty query batch")
  let answers = 0
  let answersWithin128Calls = 0
  let cacheAnswers = 0
  let cacheEvictions = 0
  let calls = 0
  let callsOnAnswers = 0
  let discoveries = 0
  let discoveredPeerCalls = 0
  let peerEvictions = 0

  for (const outcome of outcomes) {
    calls += outcome.calls
    cacheEvictions += outcome.cacheEvictions
    discoveries += outcome.discoveries
    discoveredPeerCalls += outcome.discoveredPeerCalls
    peerEvictions += outcome.peerEvictions
    if (outcome.answerKind === null) continue
    answers += 1
    if (outcome.calls <= 128) answersWithin128Calls += 1
    callsOnAnswers += outcome.calls
    if (outcome.answerKind === "cache") cacheAnswers += 1
  }

  return {
    answerRate: answers / outcomes.length,
    answerRateWithin128Calls: answersWithin128Calls / outcomes.length,
    cacheAnswerRate: cacheAnswers / outcomes.length,
    cacheEvictionsPerQuery: cacheEvictions / outcomes.length,
    callsMean: calls / outcomes.length,
    callsPerAnswer: answers === 0 ? 0 : callsOnAnswers / answers,
    deadEndRate: 1 - answers / outcomes.length,
    discoveriesPerQuery: discoveries / outcomes.length,
    discoveredPeerCallShare: calls === 0 ? 0 : discoveredPeerCalls / calls,
    peerEvictionsPerQuery: peerEvictions / outcomes.length,
  }
}

function summarizeState(world: MutableWorld): StateSummary {
  let cachedFacts = 0
  let discoveredPeers = 0
  let peers = 0

  for (const node of world.nodes) {
    cachedFacts += node.cachedFacts.length
    peers += node.peers.length
    for (const peer of node.peers) {
      if (peer.learnedAt > 0) discoveredPeers += 1
    }
  }

  return {
    discoveredPeerShare: peers === 0 ? 0 : discoveredPeers / peers,
    meanCachedFacts: cachedFacts / world.nodes.length,
    meanPeers: peers / world.nodes.length,
  }
}

function aggregateRuns(runs: ExperimentRun[]): AggregateRun[] {
  const aggregates: AggregateRun[] = []
  for (const worldKind of worldKinds) {
    for (const policy of policies) {
      const matching = runs.filter(
        (run) => run.worldKind === worldKind && run.policy === policy,
      )
      if (matching.length === 0) throw new Error("Aggregate group has no runs")
      aggregates.push({
        heldoutCallsPerAnswer: metricStats(
          matching.map((run) => run.heldoutProbe.callsPerAnswer),
        ),
        heldoutCallsPerAnswerUsingGlobalScores: metricStats(
          matching.map((run) => run.heldoutProbeGlobalScores.callsPerAnswer),
        ),
        heldoutSuccessWithin128Calls: metricStats(
          matching.map((run) => run.heldoutProbe.answerRateWithin128Calls),
        ),
        heldoutSuccessWithin128CallsUsingGlobalScores: metricStats(
          matching.map((run) => run.heldoutProbeGlobalScores.answerRateWithin128Calls),
        ),
        heldoutSuccessWithin128CallsUsingUniformSelection: metricStats(
          matching.map(
            (run) => run.heldoutProbeUniformSelection.answerRateWithin128Calls,
          ),
        ),
        policy,
        seenSuccessWithin128Calls: metricStats(
          matching.map((run) => run.seenProbe.answerRateWithin128Calls),
        ),
        trainEarlySuccessWithin128Calls: metricStats(
          matching.map((run) => run.trainEarly.answerRateWithin128Calls),
        ),
        trainLateSuccessWithin128Calls: metricStats(
          matching.map((run) => run.trainLate.answerRateWithin128Calls),
        ),
        worldKind,
      })
    }
  }
  return aggregates
}

function metricStats(values: number[]): MetricStats {
  if (values.length === 0) throw new Error("Cannot summarize empty metrics")
  const ordered = values.slice().sort((left, right) => left - right)
  let total = 0
  for (const value of values) total += value
  return {
    maximum: requireNumberAt(ordered, ordered.length - 1),
    mean: total / values.length,
    median: median(ordered),
    minimum: requireNumberAt(ordered, 0),
  }
}

function median(orderedValues: number[]): number {
  if (orderedValues.length === 0) throw new Error("Cannot take a median of no values")
  const middle = Math.floor(orderedValues.length / 2)
  if (orderedValues.length % 2 === 1) return requireNumberAt(orderedValues, middle)
  return (
    (requireNumberAt(orderedValues, middle - 1) + requireNumberAt(orderedValues, middle)) / 2
  )
}

function printReport(report: ExperimentReport): void {
  console.log(
    `nodes=${report.config.nodeCount} trainQueries=${report.config.trainQueryCount} seeds=${report.seeds.length}`,
  )
  console.log("@128=answered within 128 calls; topic deltas compare topic vs collapsed scores")
  console.log(
    [
      "world".padEnd(7),
      "policy".padEnd(12),
      "early@128".padStart(9),
      "late@128".padStart(9),
      "seen@128".padStart(9),
      "held@128".padStart(9),
      "held c/a".padStart(8),
      "score Δ@128".padStart(11),
      "topic Δ@128".padStart(11),
      "topic Δc/a".padStart(10),
    ].join("  "),
  )
  for (const aggregate of report.aggregates) {
    const topicDelta =
      aggregate.heldoutSuccessWithin128Calls.mean -
      aggregate.heldoutSuccessWithin128CallsUsingGlobalScores.mean
    const scoreDelta =
      aggregate.heldoutSuccessWithin128Calls.mean -
      aggregate.heldoutSuccessWithin128CallsUsingUniformSelection.mean
    const topicCallsDelta =
      aggregate.heldoutCallsPerAnswer.mean -
      aggregate.heldoutCallsPerAnswerUsingGlobalScores.mean
    console.log(
      [
        aggregate.worldKind.padEnd(7),
        aggregate.policy.padEnd(12),
        percent(aggregate.trainEarlySuccessWithin128Calls.mean).padStart(9),
        percent(aggregate.trainLateSuccessWithin128Calls.mean).padStart(9),
        percent(aggregate.seenSuccessWithin128Calls.mean).padStart(9),
        percent(aggregate.heldoutSuccessWithin128Calls.mean).padStart(9),
        decimal(aggregate.heldoutCallsPerAnswer.mean).padStart(8),
        signedPercent(scoreDelta).padStart(11),
        signedPercent(topicDelta).padStart(11),
        signedDecimal(topicCallsDelta).padStart(10),
      ].join("  "),
    )
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function signedPercent(value: number): string {
  const sign = value >= 0 ? "+" : ""
  return `${sign}${(value * 100).toFixed(1)}%`
}

function decimal(value: number): string {
  return value.toFixed(1)
}

function signedDecimal(value: number): string {
  const sign = value >= 0 ? "+" : ""
  return `${sign}${value.toFixed(1)}`
}

function groupFactIdsByTopic(facts: FactTruth[], topicCount: number): number[][] {
  const groups: number[][] = Array.from({ length: topicCount }, () => [])
  for (const [factId, fact] of facts.entries()) {
    requireArrayAt(groups, fact.topicId).push(factId)
  }
  return groups
}

function hasKnownFact(facts: ArrayLike<KnownFact>, factId: number): boolean {
  for (let index = 0; index < facts.length; index += 1) {
    if (requireArrayAt(facts, index).factId === factId) return true
  }
  return false
}

function requireFact(facts: FactTruth[], factId: number): FactTruth {
  const fact = facts[factId]
  if (fact === undefined) throw new Error(`Unknown fact ${factId}`)
  return fact
}

function requireNode(nodes: SimulatedNode[], nodeId: number): SimulatedNode {
  const node = nodes[nodeId]
  if (node === undefined) throw new Error(`Unknown node ${nodeId}`)
  return node
}

function requireNodeSeed(nodes: SeedNode[], nodeId: number): SeedNode {
  const node = nodes[nodeId]
  if (node === undefined) throw new Error(`Unknown seed node ${nodeId}`)
  return node
}

function requireArrayAt<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index]
  if (value === undefined) throw new Error(`Missing value at index ${index}`)
  return value
}

function requireNumberAt(values: ArrayLike<number>, index: number): number {
  const value = values[index]
  if (value === undefined) throw new Error(`Missing number at index ${index}`)
  return value
}

export function createRandom(seed: number): Random {
  return { state: seed >>> 0 }
}

function randomFloat(random: Random): number {
  random.state = (random.state + 0x6d2b_79f5) >>> 0
  let value = random.state
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
}

function randomInteger(random: Random, maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error("Random integer maximum must be positive")
  }
  return Math.floor(randomFloat(random) * maximum)
}

function shuffle<T>(values: T[], random: Random): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = randomInteger(random, index + 1)
    const value = requireArrayAt(values, index)
    values[index] = requireArrayAt(values, target)
    values[target] = value
  }
}

function mixSeed(seed: number, salt: number): number {
  let value = (seed ^ Math.imul(salt, 0x9e37_79b9)) >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x21f0_aaad)
  value = Math.imul(value ^ (value >>> 15), 0x735a_2d97)
  return (value ^ (value >>> 15)) >>> 0
}
