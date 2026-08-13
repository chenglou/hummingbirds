# Experiment 04: raw HTTP nodes

This removes the transition envelope and most of the behavioral prompt. One Bun
process binds 24 real loopback ports. Each port has a separate private corpus,
peer list, and Codex thread.

The public protocol is only:

```text
POST http://127.0.0.1:<port>/ask
Content-Type: text/plain

<raw question>
```

The response body is the raw answer. A node can synchronously call one listed
peer through the same HTTP interface with `ask_peer(address, question)`. The
open HTTP stack returns the answer, so there are no caller IDs, pending state,
answer cache, explicit return messages, or JSON transition proposals.

The runtime privately carries a trace ID and visited-node list in HTTP headers
for observability and cycle rejection. Those fields are not shown to the model.

The first test uses `route-03`, whose answer exists only at `civic-maps`:

```text
astro-ops:41003 -> civic-transit:41013 -> civic-maps:41014
```

Run it with:

```sh
bun experiments/04-raw-http/run.ts runs/04-raw-http-v3
bun experiments/04-raw-http/validate.ts \
  runs/04-raw-http-v3
```

To test the eight-word behavioral prompt:

```sh
bun experiments/04-raw-http/run.ts \
  runs/04-raw-http-minimal-v1 \
  experiments/04-raw-http/prompt-minimal.md
```

The optional fourth argument selects a request, and `all` as the fifth argument
loads the full eight-fact corpus while still asking only that request:

```sh
bun experiments/04-raw-http/run.ts \
  runs/04-raw-http-minimal-route-01 \
  experiments/04-raw-http/prompt-minimal.md \
  route-01 all
```

The optional sixth argument selects the model; it defaults to
`gpt-5.6-luna`:

```sh
bun experiments/04-raw-http/run.ts \
  runs/04-raw-http-terra-route-01 \
  experiments/04-raw-http/prompt-answer-or-forward.md \
  route-01 all gpt-5.6-terra
```

The first corrected trial and the eight-question prompt ablation are recorded
in [`conclusions.md`](conclusions.md). Machine-readable results are in
[`summary-minimal-suite-v1.json`](summary-minimal-suite-v1.json) and
[`route-05-ablation.json`](route-05-ablation.json).

The scaled ablation runner adds positional controls after the graph preset:

```text
memory.json  one|many  hard|advisory  advertise|quiet  directory|open
full|topic-role|topic|none  show|hide  fixture|selected-text
```

`selected-text` derives a local memory kind from the chosen request text; it is
precomputed for this single-question harness, not from arbitrary concurrent
HTTP bodies. See [`../06-ablations/README.md`](../06-ablations/README.md) for
the fully tested minimal configurations.
