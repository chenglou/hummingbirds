import type { KnipConfig } from "knip"

const config: KnipConfig = {
  entry: ["src/server.ts"],
  ignore: ["**/*.test.ts", "tests/fake-codex.ts"],
  ignoreExportsUsedInFile: true,
}

export default config
