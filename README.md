# Hummingbirds

Hummingbirds explores a distributed flock of stateful AI agents. Each bird knows only a few peers, learns who is useful for what, and can introduce good contributors to its callers. There is no global router or directory: the interesting behavior lives in local relationships that can strengthen, shorten, or fade through use.

A bird's learned memory lives only in its continuing model conversation. Facts, peer judgments, and routing experience compete for the same context, encouraging birds to forget weak connections and specialize. The longer-term direction is a self-hosted flock whose birds can ask their humans for knowledge that is not on the public web and split crowded contexts into new birds. Those are experiments still to come, not current features.

## Current prototype

Today, one bird is a Bun server backed by a continuing Codex CLI session. It accepts plain-text `POST /ask`, processes one model turn at a time, and persists its Codex thread ID across server restarts. The model decides whether to answer, call peers, remember contributors, or change routes; JavaScript does not implement a routing policy or knowledge store.

Nobody waits on the line. A message that wants an answer carries `x-hummingbirds-reply-to: <the sender's address>`; the bird answers 202 right away, runs its turn in its own time, and POSTs its reply there itself, tagged `x-hummingbirds-in-reply-to`. A message with no return address still gets its turn (a command, say); the bird's closing words only land in its `events.jsonl`. Codex sees each message behind a few header lines (who it's from, the request id, where to reply), which is all a bird needs to tell a late reply from a new question. The harness holds no per-request state for this; the conversation does.

The repository can launch several birds locally. They are sibling directories, and the Codex sandbox limits writes rather than reads, so a curious bird could peek at a neighbor; treat local runs as benign. Remote hosting, stable public identities, authentication, compaction stress tests, and bird splitting are not implemented yet.

## Try a local flock

```sh
bun install
codex login
bun run experiment:local-flock run experiments/local-flock/scenario.json \
  "In the fictional pelagic-lichen chronometry ledger, what exact harbor phrase is recorded for tideglass trial Nacre-A?"
```

This starts a three-bird chain whose hidden answer begins at the last bird. The harness runs a small inbox for you, hands its address to the entry bird, and prints the replies once the flock goes quiet; add `--concurrent` to fire several questions at once. Each run leaves its birds under `logs/<timestamp>/<bird>/`, and `bun run experiment:local-flock inspect <that directory>` prints the merged event log. [experiments/local-flock/moods.json](experiments/local-flock/moods.json) is a six-bird graph with a cycle and an unreachable bird; ask it how everyone is feeling, then `inspect` the run to see the walk and the replies. If `codex` is not on your PATH, point `HUMMINGBIRDS_CODEX` at the binary, for example the one inside the ChatGPT app at `/Applications/ChatGPT.app/Contents/Resources/codex`.

The runtime is [src/server.ts](src/server.ts), with [src/prompt_template.md](src/prompt_template.md) rendered as each bird's `AGENTS.md`. A bird is a directory: run the server inside it and it keeps `thread-id`, `events.jsonl`, and the `workspace/` Codex works in there. Resuming a bird needs that directory plus the same Codex home, because Codex owns the actual transcript.

Open directions are in [experiments/ideas.md](experiments/ideas.md). Run `bun run check` and `bun run knip` for deterministic verification.
