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

Requires Bun. `bun link` exposes `birds` globally; Codex is bundled, so no separate Codex or Node installation is needed. For remote login, add `--device-auth` to the login command and finish in your browser.

On Linux, install `bubblewrap`; Ubuntu 24.04 may also require the [documented AppArmor setup](https://learn.chatgpt.com/docs/sandboxing#prerequisites).

`start` stays in the foreground and prints raw events. Run `birds chat a` in another terminal for just messages. Chat also accepts a port or HTTP origin, without `/ask`.

## Across machines

Localhost is the default. For networking, replace this example with the server's reachable IP or hostname:

```sh
BIRDS_HOST=10.0.0.11 birds new shared --port 3001
birds start shared
```

Introduce birds through ordinary messages with their IDs and full addresses from `birds list`. Names and listings are local to each machine.

`new` saves the host and listening interface; restarting doesn't change them. Children inherit them and get their own ports. Use `BIRDS_BIND` if the listening interface differs from the advertised host.

Remote chat needs the chat machine's own reachable address for replies:

```sh
BIRDS_HOST=10.0.0.22 birds chat 10.0.0.11:3001 --port 3002
```

`--port` fixes the reply inbox port; otherwise a free one is chosen. Named chat uses the bird's saved network settings unless overridden. Both machines must reach each other's bird and inbox ports, including children's ports. There's no NAT traversal; alternatively, SSH to the server and chat there.

Use a private network or restrict access with a firewall. There is no authentication or encryption: anyone who can reach these ports can send work and read conversations. Don't expose them openly to the Internet.

## Manage local birds

```sh
birds new b
birds start b --detach
birds list
birds stop b
```

`new` creates a stopped bird. Its port is chosen once, or set with `--port`. `--detach` runs it in the background. `stop` drains accepted work; `start` resumes its memory. The default limit is 32 bird directories, including stopped birds; override with `HUMMINGBIRDS_MAX_BIRDS`.

Birds can create children with these same commands and teach them through messages.

## State and development

Bird state lives in `~/.birds/<id>/` (`BIRDS_HOME` to override); `bird.json` holds its settings and conversation ID. Prompts aren't regenerated on restart; update `workspace/AGENTS.md` after changing the template or moving the installation. Older birds without network settings stay on localhost; old `thread-id` files migrate on start.

Back up both the bird directories and `~/.codex/` (`CODEX_HOME` to override). The thread ID alone cannot restore a conversation. Codex home also contains login credentials.

Keep the installation outside bird-writable workspaces and temporary directories: its `new` and `start` commands bypass the workspace sandbox. Existing Codex rules also apply.

Without a global link, use `bun run birds <command>`. Run `bun run check` for type checking, lint, and tests.
