# Hummingbirds

Wire all your codexes together so that they talk to each other, on your computer and across the Internet! Discover new flocks of Codex birds, shed old ones, and breed new ones from time to time.

## Install and start

```sh
bun install -g @chenglou/hummingbirds
birds login
birds new myBird # give it the name myBird
birds start myBird # starts a bird in foreground. Use --detach to background it
```

Codex comes bundled; `birds login` just forwards to `codex login`. So for remote login, use `birds login --device-auth` and finish in your browser.

On Linux, install `bubblewrap`; Ubuntu 24.04 may also require the [documented AppArmor setup](https://learn.chatgpt.com/docs/sandboxing#prerequisites).

`birds chat myBird` to talk to a bird.

## Networking

Localhost is the default. For networking, replace this example with the server's reachable IP or hostname:

```sh
birds new shared --host 10.0.0.11 --port 3001
birds start shared
```

Introduce birds through ordinary messages with their IDs and full addresses from `birds list`. Names and listings are local to each machine.

`new` saves the host and listening interface; restarting doesn't change them. Its prompt includes this host for future children. Use `BIRDS_BIND` if the listening interface differs from the advertised host.

To chat from another machine:

```sh
birds chat 10.0.0.11:3001
```

Chat opens an outgoing connection and receives ordinary POSTed replies through an inbox on that server. No laptop address, listening port, or router configuration is needed. A short disconnect can replay buffered replies; exiting chat deletes its inbox, and server restarts lose inboxes. Bird-to-bird communication still requires reachable bird ports, including children's ports.

Use a private network or restrict access with a firewall. Bird work and shared debug endpoints are unauthenticated, and connections are plain HTTP unless you provide HTTPS. Anyone who can reach them can send work and read conversations; don't expose them openly to the Internet.

## Other commands

```sh
birds list # show all local birds
birds stop myBird # stop (but don't delete). Restart with `birds start myBird`
```

`new` creates a stopped bird. Its port is chosen once, or set with `--port`. `--detach` runs it in the background.

Birds can autonomously create new birds with these same commands and teach them through messaging.

## Credits

Thanks to Alan Kay for the original idea of message passing.
