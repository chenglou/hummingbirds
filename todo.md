# Todo

## Birds can freeze waiting on each other

Each bird takes one question at a time and queues the rest. So if b and c both decide to check with each other while each is still busy with the same request, b's question sits in c's queue and c's in b's, both on the line, nobody on a timer. They never finish, and neither does whoever asked them.

Right now the bird's server says "already on this one" (a 409) when a second question for the same request shows up, which breaks that case, but two *different* requests crossing through the same pair can still freeze the same way.

Options, roughly from smallest to biggest:

- Leave it until there's real traffic and see if it actually happens.
- Stop queueing: a busy bird just says "busy", and the asker tries someone else, tries later, or uses the mailbox instead.
- Go mailbox-only: asking a peer is always fire-and-forget and the answer comes back as a `Re:` message. Nobody ever holds the line, so there's nothing to freeze; the "already on this one" check and the "if your caller is waiting, wait" caveat both go away. Costs more turns per question and leans on the bird remembering it still owes an answer.

Leaning mailbox-only, not decided.
