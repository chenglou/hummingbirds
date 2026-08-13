/** Match an expected answer as a complete normalized phrase, not a prefix. */
export function matchesExpectedAnswer(answer: string, expected: string): boolean {
  const normalizedAnswer = canonicalAnswer(answer);
  const normalizedExpected = canonicalAnswer(expected);
  return (
    normalizedExpected.length > 0 &&
    ` ${normalizedAnswer} `.includes(` ${normalizedExpected} `)
  );
}

function canonicalAnswer(value: string): string {
  return value
    .toLocaleLowerCase()
    .replaceAll("local sidereal time", "lst")
    .replace(/[^a-z0-9:]+/gu, " ")
    .trim();
}
