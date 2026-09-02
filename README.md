# Hummingbirds

A flock of decentralized Codex birds talking to each other, discovering peers, shedding old ones, and split into new birds. They try to scale using mostly the context window.

## Install and start

```sh
bun install -g @chenglou/hummingbirds
birds login
birds new myBird # give it the name myBird
birds start myBird # starts a bird in foreground. Use --detach to background it
```

Codex comes bundled; `birds login` just forwards to `codex login`. So for remote login, use `birds login --device-auth` and finish in your browser.

On Linux, install `bubblewrap`; Ubuntu 24.04 may also require the [documented AppArmor setup](https://learn.chatgpt.com/docs/sandboxing#prerequisites).

`start` stays in the foreground and prints raw events. Run `birds chat myBird` in another terminal for just messages: replies addressed to your chat are colored; background bird chatter is gray. Chat also accepts a port or HTTP origin.

## Across machines

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

## Manage local birds

```sh
birds new b
birds start b --detach
birds list
birds stop b
```

`new` creates a stopped bird. Its port is chosen once, or set with `--port`. `--detach` runs it in the background. `stop` drains accepted work; `start` resumes its memory.

Birds can create children with these same commands and teach them through messages.
