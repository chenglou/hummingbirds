import type { KnipConfig } from "knip"

const config: KnipConfig = {
  entry: ["src/server.ts"],
  ignore: ["tests/fake-codex.ts"],
  ignoreExportsUsedInFile: true,
}

export default config
