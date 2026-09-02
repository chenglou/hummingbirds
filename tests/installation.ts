import { cp, mkdir, writeFile } from "fs/promises"
import { join } from "path"

// Exercise the real launchers against a private test package, never a runtime override
// or the installed dependency that a user's birds may already be running.
export async function createTestInstallation(directory: string) {
  await cp(join(import.meta.dir, "../src"), join(directory, "src"), { recursive: true })
  const codex = join(directory, "node_modules", "@openai", "codex")
  await mkdir(join(codex, "bin"), { recursive: true })
  await writeFile(join(codex, "package.json"), JSON.stringify({ name: "@openai/codex", type: "module" }))
  await writeFile(join(codex, "bin", "codex.js"),
    `await import(process.env.BIRDS_TEST_CODEX ?? ${JSON.stringify(join(import.meta.dir, "fake-codex.ts"))})\n`)
  const local = await import(join(directory, "src", "local.ts")) as typeof import("../src/local.ts")
  return { cliCommand: local.cliCommand, createBird: local.createBird, serverPath: join(directory, "src", "server.ts") }
}
