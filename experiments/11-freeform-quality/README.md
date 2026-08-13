# Free-form quality learning

This isolates quality reweighting from peer discovery. Four opaque peers answer
the same fictional subject with equally polished ordinary prose. Their hidden
reliability differs, but the agent sees no score, confidence field, status,
sentinel, answer wrapper, or judge JSON.

Eight calibration requests explicitly sample each peer twice. Every treatment
answer is followed in a fresh session by ordinary delayed prose saying that an
independent check found the reply accurate or inaccurate; it never reveals the
answer. A parallel self-only arm sees the same replies but receives no verified
feedback. Answer sessions may still write their own immediate judgments, as the
unchanged system prompt permits.

After calibration, four unseen questions give every arm the same complete peer
list. Each question runs from independent copies of:

- the verified-feedback notes;
- the self-judgment-only notes;
- an empty routing file.

The main measurement is whether the uniquely reliable peer, `node-17`, becomes
the first call. Answer accuracy and call count are secondary. The harness keeps
the correctness matrix only for measurement; peer replies and feedback remain
raw natural language.

```sh
bun experiments/11-freeform-quality/run.ts \
  runs/11-freeform-quality-luna gpt-5.6-luna
```

## First run

With Luna-low, verified outcome prose produced a clean behavioral split on four
unseen questions:

- verified-feedback notes: `node-17` first 4/4, one call each;
- self-judgment-only notes: `node-17` first 1/4, four calls on average;
- blank notes: `node-17` first 0/4, 3.25 calls on average.

Every arm eventually answered all four correctly. Without outcome history, the
agent compensated by asking several peers and resolving their conflicting
prose. Feedback therefore improved selection and removed redundant calls rather
than changing final accuracy in this small fixture.

All 36 model sessions were fresh, every calibration request sampled exactly its
assigned peer, and no answer phrase entered routing memory. The first runner
version reported question preservation as false because it compared the peer's
clean question with the caller's preceding “ask this peer” instruction. Raw
traces show that all four actual probes were forwarded exactly; later runner
versions measure the peer-question portion separately.
