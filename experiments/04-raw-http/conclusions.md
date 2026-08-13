# Conclusions

The raw-port design works in the first corrected trial.

- one Bun process bound 24 distinct listeners at `127.0.0.1:41001-41024`;
- every port had its own private corpus, peer list, and loaded Codex thread;
- the public request and response were plain text over `POST /ask`;
- internal forwarding crossed the real HTTP ports through `ask_peer`;
- the raw question was preserved exactly at all three nodes;
- `astro-ops -> civic-transit -> civic-maps` returned the private answer;
- the request took 9.293 seconds and three logical model turns;
- no answer cache, caller ID, pending state, or transition JSON was used.

The behavioral prompt is 52 words. The previous node prompt plus disposable
worker wrapper total 534 words, so this removes about 90% of that behavioral
prompting. Private facts and peer descriptions remain data, not instructions.

There was one useful imperfection: `civic-transit` first tried to ask
`astro-ops`, the node already waiting on it. The runtime rejected that HTTP
cycle immediately, and the same model turn then tried `civic-maps`. This costs a
tool call but does not require caller or visited metadata in the model prompt.

The earlier `runs/04-raw-http-v1` is retained. Its nested HTTP and dynamic-tool
flow reached `civic-maps`, but an experiment-code initialization bug turned the
holder's answer into HTTP 500, causing broad fallback exploration. V2 fixes only
that audit bug; it does not add routing guidance.

This is one question and one stochastic trial. The next clean ablation is to run
all eight invented questions with the 52-word prompt, then repeat with no
behavioral prompt beyond private data and the `ask_peer` tool description.

## Eight-word prompt

`runs/04-raw-http-minimal-v1` reduced the custom behavioral instruction to:

> Answer the question. Ask a peer if needed.

It also succeeded on the same question:

- direct route: `astro-ops -> civic-transit -> civic-maps`;
- two peer calls and no rejected cycle;
- raw question preserved at every hop;
- correct answer in 7.862 seconds across three logical model turns.

The latency difference from the 52-word trial is not meaningful after one
stochastic sample. The useful result is that none of the removed routing,
return-path, caching, state, concision, or anti-invention instructions were
needed for this case.

## Eight-question suite

The eight-word prompt answered 7 of 8 questions correctly. The median request
took 22.341 seconds. Five runs forwarded the original question byte-for-byte;
three runs rephrased it. The rephrasing did not cause the sole answer failure.

The failed request was `route-05`. `civic-procurement` chose the wrong first
branch and ultimately accepted a peer's “not found” answer instead of trying
its `bio-soils` neighbor. That run took 51.197 seconds, 9 model turns, 13 peer
calls, and 5 rejected cycles.

A focused 15-word prompt added only “If they don't know, try another peer.” It
found the answer, but needed 11 turns, 18 peer calls, and 51.430 seconds. The
52-word prompt also found it and selected the ideal first neighbor, but kept
searching after already receiving `Mallow-47`: 19 turns, 32 peer calls, and
102.849 seconds.

So generic retry language improves recall but encourages flooding. The next
candidate should explicitly combine three decisions: choose the likeliest
neighbor, stop on a concrete answer, and try another only on a negative reply.
This is a semantic found/not-found distinction; HTTP 200 currently means only
that the peer replied, not that it knew the answer.

The first explicit-stop prompt exposed a wording bug: “Ask the listed peer” was
unconditional, so even the answer holder asked around. It failed after 102 peer
calls. A corrected 26-word version said to answer locally first and ask one peer
at a time. It found `Mallow-47`, but still took 159.027 seconds and 47 peer calls.
“One at a time” at each node does not prevent a recursive branch from exploring
most of the graph, and the model does not reliably serialize tool calls.

The next step should therefore be a tiny host-level rule, not more prompt prose:
one active outbound call per node/request, plus a found/not-found result that
lets callers stop or backtrack. The public HTTP body can remain raw text.

Full aggregate data is in `summary-minimal-suite-v1.json`; the focused
comparison is in `route-05-ablation.json`.
