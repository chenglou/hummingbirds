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
