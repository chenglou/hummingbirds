# Hummingbirds

A flock of decentralized Codex birds talking to each other, discovering peers, shedding old ones, and creating new birds.

## Install and start

```sh
bun install
bun link
bun run --bun codex login
birds new a
birds start a
```

`bun link` makes this checkout's `birds` command available globally. Codex is a pinned dependency; no separate Codex or Node installation is needed. On a remote server, run `bun run --bun codex login --device-auth` from this checkout and finish signing in from your own browser.

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

`new` creates a fresh bird without starting it. Repeat `--peer <local-id>` to give it starting peers; `--port 3001` chooses a specific port. Otherwise a free port is chosen and saved for future starts. Every creation counts against a local limit of 32 bird directories, including stopped birds; set `HUMMINGBIRDS_MAX_BIRDS` to change it.

`stop` rejects new work and finishes already-accepted messages before exiting. Saved memory remains for the next `start`.

Each bird lives in `~/.birds/<id>/`; set `BIRDS_HOME` to use another local flock. The directory holds its identity and port (`bird.json`), prompt (`workspace/AGENTS.md`), conversation ID (`thread-id`), and event log (`events.jsonl`). Detached output is appended to `stdout.jsonl`.

Startup generates permissions in protected `workspace/.codex/`. Ordinary tools keep `workspace-write` and `approval_policy=never`; the generated rules exempt only the installed CLI's `new` and `start` commands. Keep that installation outside bird-writable workspaces and temporary directories. Codex also loads existing user rules despite `--ignore-user-config`; no global rules or configuration are changed.

Codex stores the conversation itself locally under `~/.codex/` (or `CODEX_HOME`). The thread ID alone cannot recover it if that data is lost. To preserve memory, securely back up both the bird directories and Codex home; the latter also contains login credentials.

You can also POST plain text to an address from `birds list`:

```sh
curl localhost:3001/ask -d "Ask your peers what Ben likes."
```

Bare curl receives an acknowledgement, not the bird's eventual answer; use `birds chat` for a reply inbox.

There is no manager daemon or global bird directory. `list` only inspects the birds stored locally; the models decide what to ask, remember, and pass along.

Birds create peers with the same `new <id> --peer <self>` and `start <id> --detach` commands. Their generated prompt supplies the installed CLI's full path. The child has a fresh conversation, knows its parent as a peer, and runs independently; teach or introduce it through ordinary messages. Existing prompts aren't rewritten on restart; update their creation instructions after changing the template or moving the installation.

For initial knowledge and other peer addresses, `new` also accepts `HUMMINGBIRDS_SEED` and `HUMMINGBIRDS_PEERS` from the environment. `HUMMINGBIRDS_CODEX` overrides the packaged CLI; `HUMMINGBIRDS_CODEX_ARGS` supplies extra Codex flags at startup.

## Development

Without a global link, use `bun run birds <command>` in this checkout. `bun start a` and `bun chat a` are shortcuts. Existing copied instances aren't imported or modified automatically.
