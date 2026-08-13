# Capability fallback

This tests whether the existing 71-word prompt leaves enough freedom for a node
to use both peers and one of its own capabilities. The behavior prompt is
unchanged. Every fresh node sees the same four opaque peers plus a neutral
`search_archive` tool.

Three isolated cases use invented answers and ordinary prose throughout:

- only one peer has the requested record;
- only the node's local archive has it;
- neither the peers nor archive has it.

There are no sentinels, semantic JSON results, confidence labels, or status
fields. Non-answering sources describe missing or neighboring records in normal
language. Tool transport uses the same wrapper for every reply.

This is a fallback test, not an optimal-first-choice test: cold opaque sources
provide no principled clue about which source owns each answer. A case passes
when the node reaches the useful source, or consults all five source types and
explicitly abstains. Refined searches of a node-owned capability are allowed;
they are internal work, unlike repeatedly asking the same person or peer. Calls
issued in one model batch are not treated as post-answer waste because the
harness returns their results one at a time. It must not promote neighboring
record phrases into answers or store any answer/decoy phrase in routing memory.

```sh
bun experiments/12-capability-fallback/run.ts \
  runs/12-capability-fallback-luna gpt-5.6-luna
```

## What happened

The existing 71-word prompt found the peer-only answer, but in both other cases
it queried all four peers and stopped. It never called the available archive.
That confirms its “otherwise ask peers” wording is a real capability bias.

A 67-word candidate replaced that choice with:

> Use your own capabilities and peers however seems useful.

It retained the exact-question relay rule and passed all three cases with
Luna-low:

- peer-only: found the peer answer;
- archive-only: searched the archive first and found the answer;
- nobody: consulted all four peers and the archive, rejected five neighboring
  records, and clearly said it could not find the requested phrase.

All peer questions were preserved exactly. No answer or neighboring-record
phrase entered routing memory. The raw calls still show some sources issued in
one batch after an answer-bearing source; this experiment establishes flexible
fallback, not optimal cost or stopping behavior.

The candidate is saved as [`prompt-soft.md`](prompt-soft.md). Historical
experiments keep their original prompts; prompt unification is deliberately
separate.

## Network framing

Adding one explicit role sentence produced the 89-word
[`prompt-context.md`](prompt-context.md):

> You are one node in a network of agents, each with its own knowledge,
> capabilities, and peers.

It again found all three outcomes. In the archive-only case it used only the
archive. In the nobody case it checked the archive and every peer, clearly
rejected the requested record as unavailable, and mentioned one neighboring
record as evidence. The first evaluator incorrectly treated any mention of a
neighboring phrase as promoting it to the answer; the runner now distinguishes
an explicit abstention from an unsupported answer.

The framing therefore appears helpful or neutral, and makes the intended world
clear without imposing a routing order. One run cannot establish that its
better archive stopping behavior is caused by the extra sentence.
