# Hummingbirds

Hummingbirds explores a flock of stateful AI agents. Each bird learns useful facts and peers in its continuing conversation; routes emerge from ordinary messages, not a central directory.

## Start a bird

```sh
bun install
codex login
bun start
```

`bun start` only runs the bird and prints its raw event stream. In another terminal, attach to it:

```sh
bun chat
```

Chat shows the conversation, peer messages, and replies without raw logs. Messages use the same protocol as messages between birds. To attach to a different bird, pass its port, host and port, or URL:

```sh
bun chat 3001
bun chat localhost:3001
bun chat http://localhost:3001
```

`bun chat` currently expects a local bird: its reply inbox is bound to localhost.

You can also send a message with curl:

```sh
curl localhost:3000/ask -d "What do you know about Ben?"
```

HTTP messages are accepted immediately. The bird's prompt, conversation ID, and event log stay in the ignored `bird/` directory, so restarting resumes the same bird.

## Run several birds

Each instance is an ordinary copy of `package.json` and `src/`:

```sh
for bird in a b c; do
  mkdir -p "temp/$bird"
  cp -R package.json src "temp/$bird/"
done
```

Give each copy a `.env` with its own identity, port, and starting peers:

```dotenv
HUMMINGBIRDS_NODE_ID=a
HUMMINGBIRDS_PORT=3001
HUMMINGBIRDS_PEERS="- b at http://127.0.0.1:3002/ask"
```

If `codex` is not on your terminal's `PATH`, also set `HUMMINGBIRDS_CODEX` to its absolute path. On macOS, the ChatGPT desktop app includes it at `/Applications/ChatGPT.app/Contents/Resources/codex`.

Start each independently, in its own terminal:

```sh
cd temp/a && bun start
cd temp/b && bun start
cd temp/c && bun start
```

Attach to any bird with `bun chat 3001`, or send it a message over HTTP:

```sh
curl localhost:3001/ask -d "Ask your peers what Ben likes."
```

Birds send plain-text messages to one another and return immediately. Replies arrive later as new messages. There is no flock manager; the models decide what to ask, remember, and pass along.

A bird can also hatch another independent bird through its own local `/hatch` endpoint. Each child has its own ignored `bird-<id>/` directory, starts with a fresh conversation, and learns through ordinary messages. `HUMMINGBIRDS_HATCH_MAX_BIRDS` limits each local flock to 32 children by default.

The bird server is [src/server.ts](src/server.ts), the terminal client is [src/chat.ts](src/chat.ts), and bird instructions come from [src/prompt_template.md](src/prompt_template.md). Resuming a bird also requires the same Codex home, which stores the conversation.

Open directions are in [experiments/ideas.md](experiments/ideas.md). Run `bun run check` and `bun run knip` for deterministic verification.
