# Conclusions

The successful run is `runs/02-24-node-routing-v4`:

- 24 persistent virtual agents and 43 fixed local links;
- eight concurrent requests with answers held in eight private corpora;
- 40 committed fresh-worker turns and no rejected attempts;
- all eight answers returned correctly to their origins;
- 23 agents received traffic; `astro-ephemeris` remained idle;
- seven routes matched the expected path;
- one route unexpectedly used `astro-spectra` instead of `astro-ephemeris` and
  still reached the correct holder through local peer descriptions.

The last point is the useful result: the network was not merely replaying eight
hardcoded chains. A locally plausible alternative route succeeded and preserved
concurrent state at a node also serving another request.

This does not yet show learned specialization or emergent topology. Profiles and
links were supplied in advance, facts were single-hop answers, and no answer was
independently verified. The next experiment should repeat questions over time
and let referral success counts alter later peer choices.

Earlier stopped runs are retained because they exposed real design issues:

- v1: underspecified proposal shapes;
- v2: a missing graph edge and underspecified body shapes;
- v3: an improperly rejected unexpected route, which led to the explicit rule
  that routing quality is never grounds for rejecting a valid agent turn.

Validation now distinguishes graph size from participation. An idle node still
exists, so success requires all 24 definitions to be present while reporting
touched and untouched agents separately.

## Luna-low Fast worker pool

The successful external-worker run is
`runs/02-24-node-routing-luna-fast-v3`:

- five concurrent `gpt-5.6-luna` workers at low reasoning in Fast mode;
- all eight answers correct across 46 committed turns;
- 47 attempts, with one malformed JSON response rejected and retried;
- 23 agents touched and six of eight routes matching the ideal route;
- 97.032 seconds from first worker start to final worker response;
- 99.704 seconds from run creation to the final commit;
- median attempt latency 6.465 seconds and mean latency 6.988 seconds.

The earlier Terra-low run's turn phase took 1,792.301 seconds, so the observed
worker-phase wall-clock speedup was 18.5x. This is not a pure model comparison:
the worker count rose from two to five, Fast mode was enabled, and Luna took 46
turns rather than Terra's 40.

The Amdahl-style floor is now visible. Luna v3 used 328.450 seconds of aggregate
model time, while its longest sequential request chain used 77.391 seconds.
With five workers, the work-sharing lower bound is 65.690 seconds, so the
sequential chain dominates; the measured 97.032 seconds is only about 1.25x
above the infinite-worker floor. More workers alone therefore have little room
left on this workload. Better routing or faster individual turns matter next.

Two stopped Luna runs exposed useful harness requirements:

- Luna Fast v1 answered seven requests correctly but one root sent the answer
  back to its callee instead of finalizing. The pool now checks this objective
  saved-caller invariant before committing.
- Luna Fast v2 misplaced `outgoing` and `result` inside `nextState` when a node
  held two concurrent pending requests. The worker wrapper now states the three
  top-level keys explicitly and requires unrelated concurrent state to survive.

These checks constrain transport and state-machine correctness, not route
choice. Unexpected but valid routes remain accepted.
