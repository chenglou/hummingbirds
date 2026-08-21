import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"

import {
  askNetwork,
  readTrace,
  spawnNode,
  startNetwork,
  stopNetwork,
  type Network,
} from "../experiments/local-flock/harness.ts"

const fakeCodex = { HUMMINGBIRDS_CODEX: resolve("tests/fake-codex.ts") }
const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("Hummingbirds", () => {
  test("routes through peers, learns shortcuts, and resumes after a restart", async () => {
    const trainingQuestion =
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for tideglass trial Nacre-A?"
    const probeQuestion =
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for saltclock trial Nacre-B?"
    const directory = join(await makeTemporaryDirectory(), "run")
    let network: Network | null = null

    try {
      network = await startNetwork(
        resolve("experiments/local-flock/scenario.json"),
        directory,
        fakeCodex,
      )
      const a = findNode(network, "a")
      const b = findNode(network, "b")
      const c = findNode(network, "c")
      expect(a.directory).toBe(join(directory, "a"))
      expect(new Set(network.nodes.map((node) => node.url)).size).toBe(3)

      const prompt = await readFile(resolve("src/prompt_template.md"), "utf8")
      const aAgents = await readFile(join(a.directory, "workspace", "AGENTS.md"), "utf8")
      expect(aAgents).toBe(
        prompt
          .replaceAll("[id]", "a")
          .replaceAll("[address]", a.url)
          .replaceAll("[peers]", `- b at ${b.url}`)
          .replaceAll("[seed]", "(none)"),
      )
      expect(aAgents).not.toContain(c.url)
      const cAgents = await readFile(join(c.directory, "workspace", "AGENTS.md"), "utf8")
      expect(cAgents).toContain("Amber Tern-417")
      expect(cAgents).toContain("(none)")

      // a only knows b; b knows c; c holds the answer.
      const training = await askNetwork(network, trainingQuestion, "request-training")
      expect(training).toEqual({
        answer: `Amber Tern-417.\n\nContributors: c at ${c.url}`,
        status: 200,
      })
      const trainingTrace = await readTrace(directory, "request-training")
      expect(
        trainingTrace
          .filter((event) => event.kind === "received")
          .map((event) => [event.nodeId, event.callerId, event.path]),
      ).toEqual([
        ["a", "human", []],
        ["b", "a", ["a"]],
        ["c", "b", ["a", "b"]],
      ])
      const trainingStarts = trainingTrace.filter((event) => event.kind === "started")
      expect(trainingStarts.map((event) => [event.nodeId, event.threadId])).toEqual([
        ["a", null],
        ["b", null],
        ["c", null],
      ])
      const firstThreadId = trainingTrace.find(
        (event) => event.kind === "completed" && event.nodeId === "a",
      )?.threadId
      if (typeof firstThreadId !== "string") throw new Error("a did not report its thread")
      expect(await readFile(join(a.directory, "thread-id"), "utf8")).toBe(firstThreadId)

      // Restart a on the same port and directory: it resumes the same Codex thread.
      a.process.kill()
      await a.process.exited
      const restartedA = await spawnNode(a.directory, fakeCodex, Number(new URL(a.url).port))
      network.nodes[network.nodes.indexOf(a)] = restartedA
      expect(restartedA.process.pid).not.toBe(a.process.pid)
      expect(restartedA.url).toBe(a.url)

      // a learned c's address from the first answer, so it skips b this time.
      const probe = await askNetwork(network, probeQuestion, "request-probe")
      expect(probe).toEqual({
        answer: `Violet Shoal-862.\n\nContributors: c at ${c.url}`,
        status: 200,
      })
      expect(
        (await readTrace(directory, "request-probe"))
          .filter((event) => event.kind === "received")
          .map((event) => event.nodeId),
      ).toEqual(["a", "c"])
      const aStarts = (await readTrace(directory))
        .filter((event) => event.kind === "started" && event.nodeId === "a")
        .map((event) => event.threadId)
      expect(aStarts).toEqual([null, firstThreadId])

      // A request whose path already contains a is a cycle: rejected without running Codex.
      const startsBeforeCycle = (await readTrace(directory)).filter(
        (event) => event.kind === "started",
      ).length
      const cycle = await fetch(restartedA.url, {
        method: "POST",
        headers: {
          "x-hummingbirds-path": JSON.stringify(["a"]),
          "x-hummingbirds-request-id": "request-cycle",
        },
        body: trainingQuestion,
      })
      expect(cycle.status).toBe(409)
      expect(cycle.headers.get("x-hummingbirds-request-id")).toBe("request-cycle")
      const afterCycle = await readTrace(directory)
      expect(afterCycle.filter((event) => event.kind === "started")).toHaveLength(startsBeforeCycle)
      expect(
        afterCycle.filter((event) => event.kind === "rejected").map((event) => event.requestId),
      ).toEqual(["request-cycle"])
    } finally {
      if (network !== null) await stopNetwork(network)
    }
  }, 30_000)

  test("runs one Codex turn at a time, in arrival order, while rejecting cycles immediately", async () => {
    const temporaryDirectory = await makeTemporaryDirectory()
    const scenarioPath = join(temporaryDirectory, "scenario.json")
    const directory = join(temporaryDirectory, "run")
    await writeFile(
      scenarioPath,
      JSON.stringify({ entry: "solo", nodes: [{ id: "solo", peers: [], seed: "" }] }),
    )
    let network: Network | null = null

    try {
      network = await startNetwork(scenarioPath, directory, {
        ...fakeCodex,
        HUMMINGBIRDS_FAKE_DELAY_MS: "300",
      })
      const solo = findNode(network, "solo")
      const activeNetwork = network

      const questions = Array.from({ length: 5 }, (_, index) => `question ${index}`)
      const answers = Promise.all(
        questions.map((question, index) => askNetwork(activeNetwork, question, `request-${index}`)),
      )
      await waitUntil(async () => {
        const trace = await readTrace(directory)
        return (
          trace.filter((event) => event.kind === "received").length === questions.length &&
          trace.some((event) => event.kind === "started")
        )
      })
      expect((await readTrace(directory)).filter((event) => event.kind === "started")).toHaveLength(
        1,
      )

      const cycle = fetch(solo.url, {
        method: "POST",
        headers: { "x-hummingbirds-path": JSON.stringify(["solo"]) },
        body: "cyclic question",
      })
      expect(await Promise.race([cycle.then(() => "cycle"), answers.then(() => "answers")])).toBe(
        "cycle",
      )
      expect((await cycle).status).toBe(409)

      expect((await answers).map((result) => result.answer)).toEqual(
        questions.map((question) => `Handled by solo: ${question}`),
      )
      const trace = await readTrace(directory)
      const turns = trace.filter((event) => event.kind === "started" || event.kind === "completed")
      expect(turns.map((event) => event.kind)).toEqual(
        questions.flatMap(() => ["started", "completed"]),
      )
      const admitted = trace
        .filter((event) => event.kind === "received" && event.requestId.startsWith("request-"))
        .map((event) => event.requestId)
      expect(
        turns.filter((event) => event.kind === "started").map((event) => event.requestId),
      ).toEqual(admitted)
      const threadId = turns[1]?.threadId
      expect(typeof threadId).toBe("string")
      expect(
        turns.filter((event) => event.kind === "started").map((event) => event.threadId),
      ).toEqual([null, threadId, threadId, threadId, threadId])
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

function findNode(network: Network, id: string): Network["nodes"][number] {
  const node = network.nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`Missing test node ${id}`)
  return node
}
