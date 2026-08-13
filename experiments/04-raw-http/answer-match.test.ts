import { describe, expect, test } from "bun:test";
import { matchesExpectedAnswer } from "./answer-match.ts";

describe("matchesExpectedAnswer", () => {
  test("accepts a complete answer inside concise prose", () => {
    expect(
      matchesExpectedAnswer(
        "The routing token was **Amber Harbor-467**.",
        "Amber Harbor-467",
      ),
    ).toBe(true);
  });

  test("rejects a longer token that merely starts with the expected answer", () => {
    expect(matchesExpectedAnswer("Amber Harbor-4672", "Amber Harbor-467")).toBe(
      false,
    );
  });

  test("keeps the accepted local-sidereal-time abbreviation", () => {
    expect(
      matchesExpectedAnswer("The value is 19:42 local sidereal time.", "19:42 LST"),
    ).toBe(true);
  });
});
