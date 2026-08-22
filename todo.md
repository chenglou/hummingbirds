# Todo

## Don't lose a message after saying "got it"

A bird can accept a message while it's still sitting in an in-memory queue. If the
bird restarts before handling it, the conversation comes back but the message
doesn't. Its unfinished event can also leave the flock looking busy forever.

Idea to explore: inject the harness's lifecycle into the conversation—starting,
restarting, shutting down, and work that was accepted or interrupted—and let the
prompt explain what those events mean. See how much the bird can recover on its
own before adding more machinery.
