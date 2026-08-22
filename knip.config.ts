import type { KnipConfig } from "knip"

const config: KnipConfig = {
  ignore: ["tests/fake-codex.ts"],
  ignoreExportsUsedInFile: true,
}

export default config
