# Conclusions

One loaded-thread trial supports keeping logical agents resident when low relay
latency matters:

- 24 app-server threads were created, warmed concurrently, and confirmed loaded
  before timing;
- the single request followed the ideal five-turn route and returned the correct
  private answer with no retries or tool calls;
- the resident relay took 16.994 seconds;
- the matching fresh-process relay took 28.998 seconds;
- residency was 1.71x as fast, a 41.4% steady-state latency reduction.

Starting the threads took 1.335 seconds and warming all 24 took 5.200 seconds,
both outside the requested timer. From app-server launch through the answer, the
resident variant took 23.572 seconds and was still 18.7% faster than the fresh
worker phase.

The practical result is narrower than “keep 24 models running.” Idle threads do
not perform inference. They retain local context inside one app-server process,
while inference still happens sequentially at each turn. Only three logical
nodes handled this question, so warming every node spent 24 model calls to
prepare a five-turn path. Keeping all threads loaded is useful; eagerly warming
all of them is probably unnecessary. A later system can create every thread but
warm nodes lazily or only along likely routes.

This is one question and one trial, so the 1.71x figure is directional rather
than a stable benchmark. The resident and fresh variants also use different
Codex entry points: app-server threads versus ephemeral CLI processes. A tighter
follow-up would repeat the question set and compare resident threads against
new app-server threads under the same process and prompt environment.
