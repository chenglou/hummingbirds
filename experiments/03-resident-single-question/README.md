# Experiment 03: resident agents, one question

This benchmark keeps the full 24-node graph from experiment 02 but enqueues
only `route-03`:

> On the fictional Northglass dawn-shuttle platform map, what marker labels
> the observatory crew stop?

Only `civic-maps` has the invented answer, `Amber Triangle`. The expected clean
route is `astro-ops -> civic-transit -> civic-maps`, followed by the answer
returning along the same links. Alternate local routes are valid.

The resident run starts one Codex app-server, creates and warms 24 persistent
threads, and confirms that all 24 are loaded before starting the timer. It then
routes this one request through the already-loaded threads. Warmup is reported
separately and excluded from the timed question.

The fresh control uses the same model, Fast service tier, graph, prompt, private
corpus, and question. It starts a fresh ephemeral Codex process for every turn.
Its concurrency is one because a single sequential relay has only one runnable
turn at a time.

Create and run the resident benchmark:

```sh
bun experiments/03-resident-single-question/setup.ts \
  runs/03-resident-single-question-resident-v1 \
  03-resident-single-question-resident-v1 \
  experiments/03-resident-single-question/execution-resident-luna-fast.json

bun run resident-pool \
  runs/03-resident-single-question-resident-v1 \
  24 gpt-5.6-luna low fast
```

Create and run the fresh-worker control:

```sh
bun experiments/03-resident-single-question/setup.ts \
  runs/03-resident-single-question-fresh-v1 \
  03-resident-single-question-fresh-v1 \
  experiments/03-resident-single-question/execution-fresh-luna-fast.json

bun run codex-pool \
  runs/03-resident-single-question-fresh-v1 \
  1 gpt-5.6-luna low fast
```

Check a processed run before attaching its benchmark summary and marking it
complete:

```sh
bun experiments/03-resident-single-question/validate.ts \
  runs/03-resident-single-question-resident-v1 \
  --allow-open
```

After explicit RunStore completion, omit `--allow-open` for the final check.
The validator verifies the trace, private-answer isolation, local-only sends,
runtime-managed IDs, request lineage, exactly one final answer, and empty
pending state. It reports the actual route rather than requiring the ideal one.

This compares steady-state latency, not throughput. Loaded agents sit idle
without consuming model inference, and the single relay remains sequential.

The first recorded comparison is summarized in
[`conclusions.md`](conclusions.md). The resident path took 16.994 seconds versus
28.998 seconds for fresh processes: 1.71x faster in this one trial.
