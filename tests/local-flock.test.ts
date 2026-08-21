import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"

import {
  askNetwork,
  askNetworkAsync,
  readTrace,
  spawnNode,
  startInbox,
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
      // Another branch of a request that is already running or queued here is rejected
      // too, so two branches can never wait on each other's turn. Replies still get in.
      const again = await fetch(solo.url, {
        method: "POST",
        headers: { "x-hummingbirds-request-id": "request-3" },
        body: "question 3 again",
      })
      expect([again.status, await again.text()]).toEqual([409, "Already on request-3 at solo."])

      expect((await answers).map((result) => result.answer)).toEqual(
        questions.map((question) => `Handled by solo: ${question}`),
      )
      const trace = await readTrace(directory)
      const turns = trace.filter((event) => event.kind === "started" || event.kind === "completed")
      expect(turns.map((event) => event.kind)).toEqual(
        questions.flatMap(() => ["started", "completed"]),
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
      const threadId = turns[1]?.threadId
      expect(typeof threadId).toBe("string")
      expect(
        turns.filter((event) => event.kind === "started").map((event) => event.threadId),
      ).toEqual([null, threadId, threadId, threadId, threadId])

      // Once that turn is over, the same request id is welcome again, and a late reply
      // about it is never refused.
      expect((await askNetwork(activeNetwork, "question 3 once more", "request-3")).status).toBe(
        200,
      )
      const late = await fetch(solo.url, {
        method: "POST",
        headers: { "x-hummingbirds-in-reply-to": "request-3" },
        body: "a reply about question 3",
      })
      expect(late.status).toBe(202)
    } finally {
      if (network !== null) await stopNetwork(network)
    }
  }, 15_000)

  test("passes extra Codex flags after the subcommand and refuses an empty thread-id file", async () => {
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
      expect((await askNetwork(network, "first")).status).toBe(200)
      expect((await askNetwork(network, "second")).status).toBe(200)
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

      // Saying nothing is only an error when someone is waiting on the line.
      const silent = await spawnNode(join(directory, "silent"), {
        ...fakeCodex,
        HUMMINGBIRDS_FAKE_SILENT: "1",
      })
      try {
        await writeFile(join(silent.directory, "workspace", "AGENTS.md"), "")
        const response = await fetch(silent.url, { method: "POST", body: "anyone there?" })
        expect([response.status, await response.text()]).toEqual([500, "Codex produced no answer"])
      } finally {
        silent.process.kill()
        await silent.process.exited
      }

      // An empty thread-id file is corrupt state, not a fresh bird: fail, don't fork.
      await writeFile(join(solo.directory, "thread-id"), "")
      const third = await askNetwork(network, "third")
      expect(third.status).toBe(500)
      expect(third.answer).toContain("thread-id is empty")
      expect(await readFile(join(solo.directory, "thread-id"), "utf8")).toBe("")
      expect(await readArgv()).toHaveLength(2)
    } finally {
      if (network !== null) await stopNetwork(network)
    }
  }, 15_000)

  test("lets go of the line on Reply-to and relays replies back through the chain", async () => {
    const trainingQuestion =
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for tideglass trial Nacre-A?"
    const probeQuestion =
      "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for saltclock trial Nacre-B?"
    const directory = join(await makeTemporaryDirectory(), "run")
    const inbox = startInbox()
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

      // The human hands a an inbox address: a answers 202 and asks b the same way, b asks
      // c the same way, and the answer travels back as replies, one turn per hop.
      const training = await askNetworkAsync(network, inbox, trainingQuestion, "q-train", 10_000)
      expect(training.status).toBe(202)
      expect(training.replies.map((message) => [message.from, message.body])).toEqual([
        ["a", `Amber Tern-417.\n\nContributors: c at ${c.url}`],
      ])
      const trace = await readTrace(directory, "q-train")
      expect(
        trace
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
        ["b", "c", null, "q-train", ["a", "b", "c"]],
        ["a", "b", null, "q-train", ["a", "b"]],
      ])
      expect(trace.filter((event) => event.kind === "rejected")).toEqual([])
      // Each bird finished its asking turn before the peer it asked was done, then had
      // a second turn for the reply: the opposite of the nested sync order c, b, a.
      expect(
        trace.filter((event) => event.kind === "completed").map((event) => event.nodeId),
      ).toEqual(["a", "b", "c", "b", "a"])
      expect(
        trace
          .filter((event) => event.kind === "completed" && event.nodeId === "a")
          .map((event) => event.answer),
      ).toEqual(["Asked a peer about q-train; waiting.", ""])

      // The relayed reply named c, so a now asks c directly, still without waiting.
      const probe = await askNetworkAsync(network, inbox, probeQuestion, "q-probe", 10_000)
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

      // An empty body is almost always a reply that never made it into curl.
      const empty = await fetch(a.url, {
        method: "POST",
        headers: { "x-hummingbirds-in-reply-to": "q-probe" },
        body: "",
      })
      expect([empty.status, await empty.text()]).toEqual([400, "Empty message."])
      expect((await fetch(inbox.url, { method: "POST", body: " \n" })).status).toBe(400)
      expect(inbox.messages).toHaveLength(2)

      // Waiting on the line still works in the same flock.
      expect(await askNetwork(network, trainingQuestion, "q-sync")).toEqual({
        answer: `Amber Tern-417.\n\nContributors: c at ${c.url}`,
        status: 200,
      })
      expect(inbox.messages).toHaveLength(2)

      // Giving up waiting keeps whatever arrived; the flock finishes on its own.
      const rushed = await askNetworkAsync(network, inbox, probeQuestion, "q-rush", 0)
      expect([rushed.status, rushed.settled, rushed.replies]).toEqual([202, false, []])
      expect(await waitUntilIdle(network, 10_000)).toBe(true)
      expect(inbox.messages.filter((message) => message.inReplyTo === "q-rush")).toHaveLength(1)

      // When a bird's turn fails after it let go of the line, the bird reports the failure
      // to its Reply-to address, so the asker hears what a waiting caller would have.
      await writeFile(join(c.directory, "thread-id"), "")
      const failed = await askNetworkAsync(network, inbox, probeQuestion, "q-fail", 10_000)
      expect(failed.replies.map((message) => message.from)).toEqual(["a"])
      expect(failed.replies[0]?.body).toMatch(/\/c\/thread-id is empty$/)
      const kinds = (nodeId: string): string[] =>
        failTrace.filter((event) => event.nodeId === nodeId).map((event) => event.kind)
      const failTrace = await readTrace(directory, "q-fail")
      expect(kinds("c")).toEqual(["received", "failed"])
      expect(kinds("a")).toEqual([
        "received",
        "started",
        "completed",
        "received",
        "started",
        "completed",
      ])
      expect(failTrace.find((event) => event.kind === "failed")?.replyTo).toBe(a.url)
    } finally {
      inbox.stop()
      if (network !== null) await stopNetwork(network)
    }
  }, 30_000)

  test("rejects unknown flags before starting any bird", async () => {
    const cli = async (...args: string[]): Promise<[number | null, string]> => {
      const child = Bun.spawn(
        [process.execPath, "run", "experiments/local-flock/cli.ts", ...args],
        {
          env: { ...process.env, ...fakeCodex },
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      const stderr = await new Response(child.stderr).text()
      return [await child.exited, stderr.split("\n")[0] ?? ""]
    }
    const scenario = "experiments/local-flock/scenario.json"
    expect(await cli("run", "--asycn", scenario, "hello")).toEqual([1, "Unknown flag --asycn"])
    expect(await cli("run", "--concurrent", scenario, "hello")).toEqual([
      1,
      "--concurrent needs --async",
    ])
    expect(await cli("run", "--async")).toEqual([1, "Usage:"])
  })

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
