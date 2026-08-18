import type { KnipConfig } from "knip"

const config: KnipConfig = {
  entry: ["src/cli.ts", "src/server.ts", "evals/slow-peer.ts"],
  ignore: ["**/*.test.ts", "tests/fake-codex.ts"],
  ignoreExportsUsedInFile: true,
}

export default config
