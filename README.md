# Hummingbirds

Hummingbirds explores a flock of stateful AI agents. Each bird learns useful facts and peers in its continuing conversation; routes emerge from ordinary messages, not a central directory.

## Start a bird

```sh
bun install
codex login
bun start
```

In an interactive terminal, type messages directly. Replies arrive at your local human inbox just like messages between birds. `bun start` prints every raw bird and Codex event as it arrives; without an interactive terminal, the same command runs the HTTP server for deployment.

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

Type into any bird's terminal, or send it a message over HTTP:

```sh
curl localhost:3001/ask -d "Ask your peers what Ben likes."
```

Birds send plain-text messages to one another and return immediately. Replies arrive later as new messages. There is no flock manager; the models decide what to ask, remember, and pass along.

The runtime is [src/server.ts](src/server.ts); its instructions come from [src/prompt_template.md](src/prompt_template.md). Resuming a bird also requires the same Codex home, which stores the conversation.

Open directions are in [experiments/ideas.md](experiments/ideas.md). Run `bun run check` and `bun run knip` for deterministic verification.
