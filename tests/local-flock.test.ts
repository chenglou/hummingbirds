import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"

import {
  askNetwork,
  readTrace,
  spawnNode,
  startNetwork,
  stopNetwork,
  waitUntilIdle,
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
      const inbox = network.inbox
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

      // a only knows b; b knows c; c holds the answer. The human hands a the inbox
      // address, a asks b with its own, b asks c the same way, and the answer travels
      // back as replies, one turn per hop.
      const training = await askNetwork(network, trainingQuestion, "q-train", 10_000)
      expect(training.status).toBe(202)
      expect(training.replies.map((message) => [message.from, message.body])).toEqual([
        ["a", `Amber Tern-417.\n\nContributors: c at ${c.url}`],
      ])
      const trainingTrace = await readTrace(directory, "q-train")
      expect(
        trainingTrace
          .filter((event) => event.kind === "received")
          .map((event) => [
            event.nodeId,
            event.callerId,
            event.replyTo,
            event.inReplyTo,
            event.path,
          ]),
      ).toEqual([
        ["a", "human", inbox.url, null, []],
        ["b", "a", a.url, null, ["a"]],
        ["c", "b", b.url, null, ["a", "b"]],
        // A reply carries the path the question took from the receiver on, so b would be a
        // "cycle" if it were a question. b's relay then picks up b's own path again.
        ["b", "c", c.url, "q-train", ["a", "b", "c"]],
        ["a", "b", b.url, "q-train", ["a", "b"]],
      ])
      expect(trainingTrace.filter((event) => event.kind === "rejected")).toEqual([])
      // Each bird ends its asking turn right away and has a second turn for the reply.
      const kinds = (trace: typeof trainingTrace, nodeId: string): string[] =>
        trace.filter((event) => event.nodeId === nodeId).map((event) => event.kind)
      const twoTurns = ["received", "started", "completed", "received", "started", "completed"]
      expect(kinds(trainingTrace, "a")).toEqual(twoTurns)
      expect(kinds(trainingTrace, "b")).toEqual(twoTurns)
      expect(kinds(trainingTrace, "c")).toEqual(["received", "started", "completed"])
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

      // The relayed reply named c, so a skips b this time.
      const probe = await askNetwork(network, probeQuestion, "q-probe", 10_000)
      expect(probe.replies.map((message) => message.body)).toEqual([
        `Violet Shoal-862.\n\nContributors: c at ${c.url}`,
      ])
      expect(
        (await readTrace(directory, "q-probe"))
          .filter((event) => event.kind === "received")
          .map((event) => [event.nodeId, event.callerId]),
      ).toEqual([
        ["a", "human"],
        ["c", "a"],
        ["a", "c"],
      ])
      const aStarts = (await readTrace(directory))
        .filter((event) => event.kind === "started" && event.nodeId === "a")
        .map((event) => event.threadId)
      expect(aStarts).toEqual([null, firstThreadId, firstThreadId, firstThreadId])
      expect(inbox.messages).toHaveLength(2)
    } finally {
      if (network !== null) await stopNetwork(network)
    }
  }, 30_000)

  test("runs one Codex turn at a time, in arrival order, and turns slips and cycles away at the door", async () => {
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
      const inbox = network.inbox
      const activeNetwork = network

      // Five questions at once: each is accepted on the spot, and giving up waiting
      // keeps whatever arrived so far (nothing yet).
      const questions = Array.from({ length: 5 }, (_, index) => `question ${index}`)
      const accepted = await Promise.all(
        questions.map((question, index) =>
          askNetwork(activeNetwork, question, `request-${index}`, 0),
        ),
      )
      expect(accepted).toEqual(questions.map(() => ({ replies: [], settled: false, status: 202 })))
      await waitUntil(async () => (await readTrace(directory)).some((e) => e.kind === "started"))
      expect((await readTrace(directory)).filter((event) => event.kind === "started")).toHaveLength(
        1,
      )

      // A cycle and an empty message are turned away right away, busy or not. A message
      // with no return address is just one nobody needs a reply to: it gets its turn.
      const cycle = await fetch(solo.url, {
        method: "POST",
        headers: {
          "x-hummingbirds-path": JSON.stringify(["solo"]),
          "x-hummingbirds-reply-to": inbox.url,
          "x-hummingbirds-request-id": "q-cycle",
        },
        body: "cyclic question",
      })
      expect([cycle.status, await cycle.text()]).toEqual([409, "Cycle rejected at solo."])
      expect(cycle.headers.get("x-hummingbirds-request-id")).toBe("q-cycle")
      const command = await fetch(solo.url, { method: "POST", body: "just a command" })
      expect(command.status).toBe(202)
      const empty = await fetch(solo.url, {
        method: "POST",
        headers: { "x-hummingbirds-reply-to": inbox.url },
        body: " \n",
      })
      expect([empty.status, await empty.text()]).toEqual([400, "Empty message."])
      expect((await fetch(inbox.url, { method: "POST", body: " \n" })).status).toBe(400)
      expect(
        (await readTrace(directory)).filter((event) => event.kind === "completed").length,
      ).toBeLessThan(questions.length)

      expect(await waitUntilIdle(network, 10_000)).toBe(true)
      const trace = await readTrace(directory)
      expect(
        trace.filter((event) => event.kind === "rejected").map((event) => event.error),
      ).toEqual(["Cycle rejected at solo.", "Empty message."])
      const turns = trace.filter((event) => event.kind === "started" || event.kind === "completed")
      expect(turns.map((event) => event.kind)).toEqual(
        [...questions, "command"].flatMap(() => ["started", "completed"]),
      )
      const rejected = new Set(
        trace.filter((event) => event.kind === "rejected").map((event) => event.invocationId),
      )
      const admitted = trace
        .filter((event) => event.kind === "received" && !rejected.has(event.invocationId))
        .map((event) => event.requestId)
      expect(
        turns.filter((event) => event.kind === "started").map((event) => event.requestId),
      ).toEqual(admitted)
      expect(
        inbox.messages.map((message) => [message.from, message.inReplyTo, message.body]),
      ).toEqual(
        admitted
          .slice(0, -1)
          .map((requestId) => [
            "solo",
            requestId,
            `Handled by solo: question ${requestId.slice("request-".length)}`,
          ]),
      )
      expect(turns.at(-1)?.answer).toBe("Handled by solo: just a command")
      const threadId = turns[1]?.threadId
      expect(typeof threadId).toBe("string")
      expect(
        turns.filter((event) => event.kind === "started").map((event) => event.threadId),
      ).toEqual([null, threadId, threadId, threadId, threadId, threadId])
    } finally {
      if (network !== null) await stopNetwork(network)
    }
  }, 15_000)

  test("passes extra Codex flags after the subcommand and reports a failed turn to the asker", async () => {
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
        HUMMINGBIRDS_CODEX_ARGS: " -m gpt-test  -c model_auto_compact_token_limit=20000 ",
      })
      const solo = findNode(network, "solo")
      const first = await askNetwork(network, "first", "q-first", 10_000)
      expect(first.replies.map((message) => message.body)).toEqual(["Handled by solo: first"])
      const second = await askNetwork(network, "second", "q-second", 10_000)
      expect(second.replies.map((message) => message.body)).toEqual(["Handled by solo: second"])
      const threadId = await readFile(join(solo.directory, "thread-id"), "utf8")
      const common = [
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="workspace-write"',
        "-c",
        "sandbox_workspace_write.network_access=true",
        "-c",
        "project_root_markers=[]",
        "--json",
      ]
      const extra = ["-m", "gpt-test", "-c", "model_auto_compact_token_limit=20000"]
      const argvPath = join(solo.directory, "workspace", ".fake-codex", "argv.jsonl")
      const readArgv = async (): Promise<string[][]> =>
        (await readFile(argvPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      expect(await readArgv()).toEqual([
        ["--search", "exec", ...common, ...extra, "-"],
        ["--search", "exec", "resume", ...common, ...extra, threadId, "-"],
      ])

      // An empty thread-id file is corrupt state, not a fresh bird: fail, don't fork.
      // Nobody is on the line to see it, so the bird tells the asker itself.
      await writeFile(join(solo.directory, "thread-id"), "")
      const third = await askNetwork(network, "third", "q-third", 10_000)
      expect(third.settled).toBe(true)
      expect(third.replies.map((message) => message.from)).toEqual(["solo"])
      expect(third.replies[0]?.body).toMatch(/\/solo\/thread-id is empty$/)
      expect((await readTrace(directory, "q-third")).map((event) => event.kind)).toEqual([
        "received",
        "failed",
      ])
      expect(await readFile(join(solo.directory, "thread-id"), "utf8")).toBe("")
      expect(await readArgv()).toHaveLength(2)

      // A failed reply turn is only recorded, never reported back: that is what keeps
      // two failing birds from bouncing failure reports at each other forever.
      const late = await fetch(solo.url, {
        method: "POST",
        headers: {
          "x-hummingbirds-in-reply-to": "q-third",
          "x-hummingbirds-reply-to": network.inbox.url,
        },
        body: "a late reply about q-third",
      })
      expect(late.status).toBe(202)
      expect(await waitUntilIdle(network, 10_000)).toBe(true)
      expect((await readTrace(directory, "q-third")).map((event) => event.kind)).toEqual([
        "received",
        "failed",
        "received",
        "failed",
      ])
      expect(network.inbox.messages).toHaveLength(3)
    } finally {
      if (network !== null) await stopNetwork(network)
    }
  }, 15_000)

  test("rejects a broken scenario before starting any bird", async () => {
    const temporaryDirectory = await makeTemporaryDirectory()
    const scenarioPath = join(temporaryDirectory, "scenario.json")
    const directory = join(temporaryDirectory, "run")
    await writeFile(
      scenarioPath,
      JSON.stringify({
        entry: "a",
        nodes: [
          { id: "a", peers: ["b"], seed: "" },
          { id: "a", peers: [], seed: "" },
        ],
      }),
    )
    const started = await startNetwork(scenarioPath, directory, fakeCodex).then(
      () => "started",
      (error: unknown) => String(error),
    )
    expect(started).toBe("Error: Duplicate node ID: a")
    expect(existsSync(directory)).toBe(false)
  })
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
