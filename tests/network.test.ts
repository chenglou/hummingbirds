import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import {
  askNetwork,
  readTrace,
  startNetwork,
  stopNetwork,
  type RunningNetwork,
} from "../src/harness.ts"
import { headers } from "../src/protocol.ts"

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("Hummingbirds", () => {
  test("resumes each bird's session and learns a route in context", async () => {
    const trainingQuestion =
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for tideglass trial Nacre-A?"
    const probeQuestion =
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for saltclock trial Nacre-B?"
    const temporaryDirectory = await makeTemporaryDirectory()
    const runDirectory = join(temporaryDirectory, "run")
    let network: RunningNetwork | null = null

    try {
      network = await startNetwork(resolve("example/scenario.json"), runDirectory, {
        HUMMINGBIRDS_CODEX_COMMAND: JSON.stringify([
          process.execPath,
          "run",
          resolve("tests/fake-codex.ts"),
        ]),
        HUMMINGBIRDS_CODEX_JSON_TRACE: "1",
        HUMMINGBIRDS_FAKE_STATE_DIRECTORY: join(temporaryDirectory, "fake-codex"),
      })

      const a = findNode(network, "a")
      const b = findNode(network, "b")
      const c = findNode(network, "c")
      expect(a.directory.startsWith(runDirectory)).toBe(false)
      expect(b.directory.startsWith(runDirectory)).toBe(false)
      expect(dirname(a.directory)).not.toBe(dirname(b.directory))
      expect(await Bun.file(join(a.directory, "events.jsonl")).exists()).toBe(false)
      expect(await Bun.file(join(runDirectory, "a", "events.jsonl")).exists()).toBe(true)
      expect(new Set(network.nodes.map((node) => node.pid)).size).toBe(3)
      expect(new Set(network.nodes.map((node) => node.url)).size).toBe(3)
      expect(await readFile(join(a.directory, "server.ts"), "utf8")).toBe(
        await readFile(resolve("src/server.ts"), "utf8"),
      )
      expect(await readFile(join(a.directory, "prompt.md"), "utf8")).toBe(
        await readFile(resolve("src/prompt.md"), "utf8"),
      )

      const prompt = await readFile(resolve("src/prompt.md"), "utf8")
      const aAgents = await readFile(join(a.directory, "AGENTS.md"), "utf8")
      expect(aAgents).toBe(
        prompt
          .replaceAll("[id]", "a")
          .replaceAll("[address]", a.url)
          .replaceAll("[peers]", `- b at ${b.url}`)
          .replaceAll("[seed]", "(none)"),
      )
      expect(aAgents).not.toContain(c.url)
      const cAgents = await readFile(join(c.directory, "AGENTS.md"), "utf8")
      expect(cAgents).toContain("Amber Tern-417")
      expect(cAgents).toContain("Violet Shoal-862")
      expect(cAgents).toContain("Your initial peers are:\n(none)")
      expect(await Bun.file(join(a.directory, "knowledge.md")).exists()).toBe(false)
      expect(await Bun.file(join(a.directory, "nodes.md")).exists()).toBe(false)

      const trainingResult = await askNetwork(network, trainingQuestion, "request-training")
      expect(trainingResult.answer).toBe(`Amber Tern-417.\n\nContributors: c at ${c.url}`)
      expect(trainingResult.status).toBe(200)

      const trainingTrace = await readTrace(runDirectory, "request-training")
      expect(
        trainingTrace
          .filter((event) => event.kind === "request_received")
          .map((event) => [event.nodeId, event.callerId]),
      ).toEqual([
        ["a", "human"],
        ["b", "a"],
        ["c", "b"],
      ])
      const trainingStarts = trainingTrace.filter(
        (event) => event.kind === "codex_process_started",
      )
      expect(trainingStarts.map((event) => event.nodeId)).toEqual(["a", "b", "c"])
      expect(trainingStarts.every((event) => event.threadId === null)).toBe(true)
      expect(new Set(trainingStarts.map((event) => event.agentPid)).size).toBe(3)
      const aStart = trainingStarts.find((event) => event.nodeId === "a")
      if (aStart?.kind !== "codex_process_started" || aStart.codexEvents === null) {
        throw new Error("Missing Codex JSON trace")
      }
      expect(await readFile(join(a.directory, aStart.codexEvents), "utf8")).toContain(
        '"type":"turn.completed"',
      )

      const probeResult = await askNetwork(network, probeQuestion, "request-probe")
      expect(probeResult.answer).toBe(`Violet Shoal-862.\n\nContributors: c at ${c.url}`)
      expect(probeResult.status).toBe(200)
      const probeTrace = await readTrace(runDirectory, "request-probe")
      expect(
        probeTrace
          .filter((event) => event.kind === "request_received")
          .map((event) => event.nodeId),
      ).toEqual(["a", "c"])

      const fullTrace = await readTrace(runDirectory)
      const aStarts = fullTrace
        .filter((event) => event.kind === "codex_process_started")
        .filter((event) => event.nodeId === "a")
      const aCompletions = fullTrace
        .filter((event) => event.kind === "codex_process_completed")
        .filter((event) => event.nodeId === "a")
      expect(aStarts).toHaveLength(2)
      expect(aCompletions).toHaveLength(2)
      const firstThreadId = aCompletions[0]?.threadId
      if (firstThreadId === undefined) throw new Error("Missing first A thread")
      expect(aStarts.map((event) => event.threadId)).toEqual([null, firstThreadId])
      expect(aCompletions.map((event) => event.threadId)).toEqual([
        firstThreadId,
        firstThreadId,
      ])
      expect(await Bun.file(join(a.directory, "knowledge.md")).exists()).toBe(false)
      expect(await Bun.file(join(a.directory, "nodes.md")).exists()).toBe(false)

      const startsBeforeCycle = fullTrace.filter(
        (event) => event.kind === "codex_process_started",
      ).length
      const cycleResponse = await fetch(a.url, {
        method: "POST",
        headers: {
          [headers.callerId]: "test",
          [headers.path]: JSON.stringify(["a"]),
          [headers.requestId]: "request-cycle",
        },
        body: trainingQuestion,
      })
      expect(cycleResponse.status).toBe(409)
      expect(
        (await readTrace(runDirectory)).filter(
          (event) => event.kind === "codex_process_started",
        ).length,
      ).toBe(startsBeforeCycle)

      await writeFile(join(a.directory, "events.jsonl"), "poisoned workspace trace\n")
      await stopNetwork(network)
      network = null
      expect(await Bun.file(join(a.directory, "AGENTS.md")).exists()).toBe(false)
      expect(await readFile(join(runDirectory, "a", "AGENTS.md"), "utf8")).toBe(aAgents)
      expect(await readFile(join(runDirectory, "a", "events.jsonl"), "utf8")).not.toContain(
        "poisoned workspace trace",
      )
      expect(await readFile(join(runDirectory, "a", aStart.codexEvents), "utf8")).toContain(
        '"type":"turn.completed"',
      )
      expect(await readTrace(runDirectory, "request-probe")).not.toHaveLength(0)
    } finally {
      if (network !== null) await stopNetwork(network)
    }
  }, 30_000)

  test("serializes concurrent requests while rejecting cycles immediately", async () => {
    const temporaryDirectory = await makeTemporaryDirectory()
    const scenarioPath = join(temporaryDirectory, "scenario.json")
    const runDirectory = join(temporaryDirectory, "run")
    await writeFile(
      scenarioPath,
      `${JSON.stringify(
        { entry: "solo", nodes: [{ id: "solo", peers: [], seed: "" }] },
        null,
        2,
      )}\n`,
    )
    let network: RunningNetwork | null = null

    try {
      network = await startNetwork(scenarioPath, runDirectory, {
        HUMMINGBIRDS_CODEX_COMMAND: JSON.stringify([
          process.execPath,
          "run",
          resolve("tests/fake-codex.ts"),
        ]),
        HUMMINGBIRDS_CODEX_JSON_TRACE: "1",
        HUMMINGBIRDS_FAKE_DELAY_MS: "1000",
        HUMMINGBIRDS_FAKE_STATE_DIRECTORY: join(temporaryDirectory, "fake-codex"),
      })
      const solo = findNode(network, "solo")

      const first = askNetwork(network, "first concurrent question", "request-first")
      await waitUntil(async () =>
        (await readTrace(runDirectory, "request-first")).some(
          (event) => event.kind === "codex_process_started",
        ),
      )
      const second = askNetwork(network, "second concurrent question", "request-second")
      await waitUntil(async () =>
        (await readTrace(runDirectory, "request-second")).some(
          (event) => event.kind === "request_received",
        ),
      )

      expect(
        (await readTrace(runDirectory)).filter(
          (event) => event.kind === "codex_process_started",
        ),
      ).toHaveLength(1)

      const cycle = fetch(solo.url, {
        method: "POST",
        headers: {
          [headers.path]: JSON.stringify(["solo"]),
          [headers.requestId]: "request-cycle-while-busy",
        },
        body: "cyclic question",
      })
      const firstFinished = first.then(() => "first" as const)
      const secondFinished = second.then(() => "second" as const)
      expect(
        await Promise.race([cycle.then(() => "cycle" as const), firstFinished, secondFinished]),
      ).toBe("cycle")
      const cycleResponse = await cycle
      expect(cycleResponse.status).toBe(409)

      const [firstResult, secondResult] = await Promise.all([first, second])
      expect(firstResult.answer).toBe("Handled by solo: first concurrent question")
      expect(secondResult.answer).toBe("Handled by solo: second concurrent question")

      const trace = await readTrace(runDirectory)
      const processEvents = trace.filter(
        (event) =>
          event.nodeId === "solo" &&
          (event.kind === "codex_process_started" || event.kind === "codex_process_completed"),
      )
      expect(processEvents.map((event) => event.kind)).toEqual([
        "codex_process_started",
        "codex_process_completed",
        "codex_process_started",
        "codex_process_completed",
      ])
      const completions = processEvents.filter(
        (event) => event.kind === "codex_process_completed",
      )
      const starts = processEvents.filter((event) => event.kind === "codex_process_started")
      const activeThreadId = completions[0]?.threadId
      if (activeThreadId === undefined) throw new Error("Missing solo thread")
      expect(starts.map((event) => event.threadId)).toEqual([null, activeThreadId])
      expect(completions.map((event) => event.threadId)).toEqual([
        activeThreadId,
        activeThreadId,
      ])
      expect(
        trace.filter(
          (event) =>
            event.kind === "cycle_rejected" && event.requestId === "request-cycle-while-busy",
        ),
      ).toHaveLength(1)
    } finally {
      if (network !== null) await stopNetwork(network)
    }
  }, 15_000)
})

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hummingbirds-"))
  temporaryDirectories.push(directory)
  return directory
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000
  for (;;) {
    if (await check()) return
    if (performance.now() >= deadline) throw new Error("Condition timed out")
    await Bun.sleep(10)
  }
}

function findNode(network: RunningNetwork, id: string): RunningNetwork["nodes"][number] {
  const node = network.nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`Missing test node ${id}`)
  return node
}
