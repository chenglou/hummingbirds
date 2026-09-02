# Explicit host when creating children

2026-09-02. `birds new --host <IP-or-hostname>` replaces `BIRDS_HOST`. The generated creation command contains the bird's normalized host literally, including in children's prompts. `BIRDS_BIND` and persisted network settings are unchanged; old host environment values are ignored and cleared before launching Codex.

Two fresh Sol/high runs used Codex 0.149.1, Bun 1.4.0, and the current general splitting/handoff prompt. Each replayed the first 13 ordinary messages and original arrival offsets from the earlier Foldlight changing-sheets scenario: five birds, display measurements, packing rules, event copy, quotes and revisions. No human input asked for splitting or organization. No environment-based control arm was run.

All birds advertised `flock.test` while binding to `0.0.0.0`; omitting `--host` would have produced the wrong saved host. Apps/plugins were disabled, with normal workspace sandboxes and scoped CLI creation rules. The disposable containers had separate networks, no host mounts and no published ports.

- Run 1 created six children: s → foldcalc; r → packr and displayr; packr → packr-a and packr-b; displayr → foldscout. All six native `new` calls supplied literal `--host flock.test` and succeeded. Every saved child host/bind was correct, and all six received work from their parents.
- All six advertised child URLs were reachable from a separate credential-free container. The same ports on that container's localhost were unreachable: this was not merely a same-process/local-loopback check.
- Run 2 did not split. That supplies no additional evidence about host copying, and is not a failed splitting decision by itself.

Both networks still had queued work four minutes after the last scheduled message, hitting the predeclared quiet-wait cutoff. These are limited host-copying observations, not completed workload or useful-splitting passes. The planned child replies after stopping the initial birds were not reached. Run 1 required terminating its remaining cleanup wait; run 2's controller finished its cleanup block with logged stop timeouts. Logs include shutdown-induced errors and must not be graded as if all callbacks were ordinary successful answers.

A separate log audit found every recorded connection failure followed its destination's cleanup stop, with the correct host and port. Other command/protocol errors were unrelated to host selection. Five children made successful HTTP posts; the sixth remained unfinished searching product catalogs. No wrong-host regression was observed.

Automated coverage passes: 72 tests, plus type checking, lint and Knip. It includes executing actual generated parent/child creation instructions for hostname and IPv6 cases, persisted networking, stale-environment removal and scoped command rules. A final validation fix rejects option-like hosts such as `--help`; this does not change the tested `flock.test` prompt or behavior.

Existing birds/prompts were untouched. Refresh their creation instruction before upgrading a networked flock: an old bare `new <id>` command no longer inherits the host through an environment variable.

Raw source snapshot, scenario, controller, native commands/sessions, probe results and state are at `/Users/chenglou/Documents/Codex/host-param-20260902.YJln6r/`. Both test containers/networks and their credential copies were removed; evidence was retained. Run 1's interrupted controller left a stale summary with `failure: null`; its controller log and `audit.json` preserve the actual timeout.
