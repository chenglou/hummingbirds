# Hummingbirds

A flock of decentralized Codex birds talking to each other, discovering new birds, shedding old ones, and growing & hatching new birds

## Install and start

```sh
bun install
bun link
birds login
birds new a
birds start a
```

`bun link` makes this checkout's `birds` command available globally. Codex is a pinned dependency; no separate Codex or Node installation is needed. On a remote server, use `birds login --device-auth` and finish signing in from your own browser.

On Linux, install `bubblewrap`; Ubuntu 24.04 may also require the [documented AppArmor setup](https://learn.chatgpt.com/docs/sandboxing#prerequisites).

This uses the Codex you're used to, plus a thin prompt to make it understand it's one bird of a flock.

`birds start` stays in the foreground and prints the raw event stream. In another terminal:

```sh
birds chat a
```

Chat shows messages without raw logs. Local names, ports, and HTTP origins work:

```sh
birds chat a
birds chat 3001
birds chat http://localhost:3001
```

The birds use the same HTTP message protocol among themselves. In that sense, they see you as just another bird too. Messages are accepted immediately; actual replies arrive later as new messages.

The server and chat inbox currently bind to localhost. To use a bird on a remote server, SSH there and run `birds chat <id>` on that machine. Cross-machine flocks aren't supported yet.

## Manage local birds

```sh
birds new b --peer a
birds start b --detach
birds list
birds stop b
birds start b
```

`new` creates a fresh bird without starting it. Repeat `--peer <local-id>` to give it starting peers; `--port 3001` chooses a specific port. Otherwise a free port is chosen and saved for future starts.

`stop` rejects new work and finishes already-accepted messages before exiting. `kill` interrupts work immediately. Neither deletes saved memory; interrupted or queued messages can be lost when killed.

Known Linux limitation: `kill` can leave a running Codex tool subprocess behind; prefer `stop` for now.

Each bird lives in `~/.birds/<id>/`; set `BIRDS_HOME` to use another local flock. The directory holds its identity and port (`bird.json`), prompt (`workspace/AGENTS.md`), conversation ID (`thread-id`), and event log (`events.jsonl`). Detached output is appended to `stdout.jsonl`.

Codex stores the conversation itself locally under `~/.codex/` (or `CODEX_HOME`). The thread ID alone cannot recover it if that data is lost. To preserve memory, securely back up both the bird directories and Codex home; the latter also contains login credentials.

You can also POST plain text to an address from `birds list`:

```sh
curl localhost:3001/ask -d "Ask your peers what Ben likes."
```

Bare curl receives an acknowledgement, not the bird's eventual answer; use `birds chat` for a reply inbox.

There is no manager daemon or global bird directory. `list` only inspects the birds stored locally; the models decide what to ask, remember, and pass along.

A bird can hatch another through its own `/hatch` endpoint. This uses the same creation and startup code as the CLI. The child has a fresh conversation, knows its parent as a peer, and runs independently. `HUMMINGBIRDS_HATCH_MAX_BIRDS` caps local hatching at 32 birds, including existing birds.

For initial knowledge and other peer addresses, `new` also accepts `HUMMINGBIRDS_SEED` and `HUMMINGBIRDS_PEERS` from the environment. `HUMMINGBIRDS_CODEX` overrides the packaged CLI; `HUMMINGBIRDS_CODEX_ARGS` supplies extra Codex flags at startup.

## Development

Without a global link, use `bun run birds <command>` in this checkout. `bun start a` and `bun chat a` are shortcuts. Existing copied instances aren't imported or modified automatically.

Run `bun run check` and `bun run knip` for deterministic verification. Open directions are in [experiments/ideas.md](experiments/ideas.md).
