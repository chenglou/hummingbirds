import { describe, expect, test } from "bun:test"

import {
  scoreSlowPeerTrial,
  type SlowPeerObservation,
} from "../evals/slow-peer.ts"

const passing: SlowPeerObservation = {
  answerMatched: true,
  attributionMatched: true,
  danglingCommandIds: [],
  peerAbortedCount: 0,
  peerReceiptCount: 1,
  peerReleaseCount: 1,
  processFailureCount: 0,
  status: 200,
  turnCompleted: true,
}

describe("slow peer eval scoring", () => {
  test("accepts one completed peer call", () => {
    expect(scoreSlowPeerTrial(passing)).toEqual({ passed: true, reasons: [] })
  })

  test("rejects duplicate peer calls", () => {
    expect(scoreSlowPeerTrial({ ...passing, peerReceiptCount: 2 }).passed).toBe(false)
  })

  test("rejects an abandoned command", () => {
    expect(
      scoreSlowPeerTrial({ ...passing, danglingCommandIds: ["item-1"] }).reasons,
    ).toContain("unfinished commands: item-1")
  })
})
