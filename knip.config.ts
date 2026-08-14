import type { KnipConfig } from "knip"

const config: KnipConfig = {
  entry: ["src/cli.ts", "src/server.ts"],
  ignore: ["**/*.test.ts"],
  ignoreExportsUsedInFile: true,
}

export default config
