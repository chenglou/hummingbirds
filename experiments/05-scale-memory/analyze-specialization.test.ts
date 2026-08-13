import { describe, expect, test } from "bun:test";
import { analyzeSpecialization } from "./analyze-specialization.ts";

describe("analyzeSpecialization", () => {
  test("counts only positive memory and excludes route endpoints from hubs", () => {
    const report = analyzeSpecialization(
      {
        origin: [
          { kind: "astral", peerId: "hub", outcome: "answered" },
          { kind: "astral", peerId: "wrong", outcome: "not_found" },
        ],
        hub: [
          { kind: "astral", peerId: "holder" },
          { kind: "civic", peerId: "other-holder", outcome: "answered" },
        ],
      },
      [
        { ok: true, route: ["origin", "hub", "holder"] },
        { ok: false, route: ["other-origin", "hub", "detour", "other-holder"] },
      ],
    );

    expect(report.totals).toEqual({
      nodes: 6,
      learnedRoutingRows: 3,
      distinctKinds: 2,
      summaries: 2,
      successfulSummaries: 1,
      intermediaryAppearances: 3,
      successfulIntermediaryAppearances: 1,
    });
    expect(report.nodes.find((node) => node.nodeId === "origin")).toMatchObject({
      learnedRoutingRows: 1,
      distinctKinds: ["astral"],
      appearancesAsIntermediary: 0,
    });
    expect(report.nodes.find((node) => node.nodeId === "hub")).toEqual({
      nodeId: "hub",
      learnedRoutingRows: 2,
      distinctKinds: ["astral", "civic"],
      appearancesAsIntermediary: 2,
      successfulAppearancesAsIntermediary: 1,
    });
    expect(report.topHubs[0]?.nodeId).toBe("hub");
    expect(report.nodes.find((node) => node.nodeId === "holder")?.appearancesAsIntermediary).toBe(0);
  });

  test("rejects an unknown memory outcome", () => {
    expect(() =>
      analyzeSpecialization({
        node: [{ kind: "astral", peerId: "peer", outcome: "maybe" }],
      }),
    ).toThrow("unknown routing-memory outcome");
  });
});
