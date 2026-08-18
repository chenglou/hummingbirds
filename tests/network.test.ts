import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

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
  test("runs fresh full-agent processes and persists their learned route", async () => {
    const trainingQuestion =
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for tideglass trial Nacre-A?"
    const probeQuestion =
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for saltclock trial Nacre-B?"
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "hummingbirds-"))
    temporaryDirectories.push(temporaryDirectory)
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
      })

      const a = findNode(network, "a")
      const b = findNode(network, "b")
      const c = findNode(network, "c")
      expect(new Set(network.nodes.map((node) => node.pid)).size).toBe(3)
      expect(new Set(network.nodes.map((node) => node.url)).size).toBe(3)
      expect(await readFile(join(a.directory, "server.ts"), "utf8")).toBe(
        await readFile(resolve("src/server.ts"), "utf8"),
      )
      expect(await readFile(join(a.directory, "prompt.md"), "utf8")).toBe(
        await readFile(resolve("src/prompt.md"), "utf8"),
      )
      expect(await readFile(join(a.directory, "AGENTS.md"), "utf8")).toBe(
        (await readFile(resolve("src/prompt.md"), "utf8"))
          .replaceAll("[id]", "a")
          .replaceAll("[address]", a.url),
      )

      const initialA = await readFile(join(a.directory, "nodes.md"), "utf8")
      expect(initialA).toBe(`# Known nodes\n\n- b at ${b.url} — known, but no experience yet.\n`)
      expect(initialA).not.toContain("c at")

      const trainingResult = await askNetwork(network, trainingQuestion, "request-training")
      expect(trainingResult.answer).toBe(`Amber Tern-417.\n\nContributors: c at ${c.url}`)
      expect(trainingResult.status).toBe(200)

      const trainedA = await readFile(join(a.directory, "nodes.md"), "utf8")
      expect(trainedA).toContain(`b at ${b.url}`)
      expect(trainedA).toContain(`c at ${c.url}`)
      expect(trainedA).not.toContain("Amber Tern-417")
      expect(await readFile(join(b.directory, "nodes.md"), "utf8")).toContain(`c at ${c.url}`)
      expect(await readFile(join(a.directory, "knowledge.md"), "utf8")).toContain(
        "Nacre-A records the exact harbor phrase “Amber Tern-417.”",
      )

      const trace = await readTrace(runDirectory, "request-training")
      expect(
        trace
          .filter((event) => event.kind === "request_received")
          .map((event) => [event.nodeId, event.callerId]),
      ).toEqual([
        ["a", "human"],
        ["b", "a"],
        ["c", "b"],
      ])
      const starts = trace.filter((event) => event.kind === "codex_process_started")
      expect(starts.map((event) => event.nodeId)).toEqual(["a", "b", "c"])
      expect(new Set(starts.map((event) => event.agentPid)).size).toBe(3)
      expect(starts.every((event) => !network?.nodes.some((node) => node.pid === event.agentPid))).toBe(
        true,
      )
      const aStart = starts.find((event) => event.nodeId === "a")
      expect(aStart?.codexEvents).not.toBeNull()
      if (aStart?.codexEvents === null || aStart?.codexEvents === undefined) {
        throw new Error("Missing Codex JSON trace")
      }
      expect(await readFile(join(a.directory, aStart.codexEvents), "utf8")).toContain(
        '"type":"turn.completed"',
      )

      const probeResult = await askNetwork(network, probeQuestion, "request-probe")
      expect(probeResult.answer).toBe(`Violet Shoal-862.\n\nContributors: c at ${c.url}`)
      const probeTrace = await readTrace(runDirectory, "request-probe")
      expect(
        probeTrace
          .filter((event) => event.kind === "request_received")
          .map((event) => event.nodeId),
      ).toEqual(["a", "c"])
      expect(await readFile(join(a.directory, "knowledge.md"), "utf8")).toContain(
        "Nacre-B records the exact harbor phrase “Violet Shoal-862.”",
      )

      const startsBeforeCycle = (await readTrace(runDirectory)).filter(
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
        (await readTrace(runDirectory)).filter((event) => event.kind === "codex_process_started")
          .length,
      ).toBe(startsBeforeCycle)
    } finally {
      if (network !== null) await stopNetwork(network)
    }
  }, 30_000)
})

function findNode(network: RunningNetwork, id: string): RunningNetwork["nodes"][number] {
  const node = network.nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`Missing test node ${id}`)
  return node
}
