# Todo

## Don't lose a message after saying "got it"

A bird can accept a message while it's still sitting in an in-memory queue. If the
bird restarts before handling it, the conversation comes back but the message
doesn't. Its unfinished event can also leave the flock looking busy forever.

Idea to explore: inject the harness's lifecycle into the conversation—starting,
restarting, shutting down, and work that was accepted or interrupted—and let the
prompt explain what those events mean. See how much the bird can recover on its
own before adding more machinery.

## Reduce routine chatter without suppressing useful thoughts

Possible prompt addition: "Assistant messages are private notes for your future
self; they are not delivered. Do not narrate routine sends or acknowledgments.
Keep only information worth remembering."

Check whether birds can make consecutive useful `curl` calls without talking
between them, while still sending additional messages or preserving important
thoughts when appropriate. Measure the actual overhead before optimizing.

## Broadcast information without broadcasting cognition

Every delivered message currently starts a full model turn. Explore cheap
delivery with selective activation through inboxes, batching, subscriptions,
mentions, or pull—without spending a full turn just to decide what merits one.

## Clean up Linux tools on forced cancellation

With Codex 0.149.1 on Ubuntu 24.04, `birds kill` stops the bird and Codex but can leave an inner `codex-linux-sandbox` process and its foreground tool running. A real `sleep 60` survived at least five seconds after cancellation. Signaling the parent process group instead of its PID did not help; the inner sandbox had its own process group. Targeting that inner group did clean up the tool.

Prefer graceful `stop` meanwhile. Check for a native Codex fix before adding descendant-process management to the harness, and retain a real Linux subprocess regression test: our fake-Codex tests pass without catching this.
