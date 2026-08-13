# Route repair

This is a separate, repair-only follow-up to the isolated routing experiment.
It reuses the same prompt without adding a score, schema, or cleanup rule.

One fictional subject starts at `node-17` and silently moves to `node-68`.
Every question gets a fresh model session; only free-form `routing.md` persists.
The four turns are:

1. learn the old route;
2. encounter that stale route after the move and find the new peer;
3. answer a new related question from a copy of the repaired file;
4. ask the same question from a copy of the stale file as a control.

The repair passes when the first post-move call follows the stale route, the
router recovers and updates its file, the repaired copy calls the new peer first
and only once, and the stale control still calls the old peer first. Invented
answers must never appear in `routing.md`.

```sh
bun experiments/09-route-repair/run.ts \
  runs/09-route-repair-luna gpt-5.6-luna
```

## What happened

The strict one-example repair test did not pass.

With Luna-low, the router followed the remembered `node-17` route after the
move, received `NOT_FOUND`, searched the remaining peers, and found `node-68`.
It appended that evidence without deleting the older positive note. On the next
related question it tried `node-17` and then `node-68`: two calls, compared with
four from the stale-file control. That is useful partial repair, but not full
replacement of the stale route.

In one exact Terra-low comparison, the router followed `node-17`, received
`NOT_FOUND`, updated the note, and stopped instead of trying the other listed
peers. A later fresh question did eventually discover `node-68`, but the repair
turn itself failed to answer.

Both models preserved the forwarded questions, and neither stored an answer in
`routing.md`. The weak prompt therefore supports learning new positive and
negative evidence, but does not reliably mean “replace the old general route
after one miss.” We leave that failure visible rather than add a repair rule.
