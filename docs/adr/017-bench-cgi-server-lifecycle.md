# ADR-017: Bench `git-http-backend` server lifecycle

## Status

Accepted (at `a191a353129d43ab8400c6cd240c16a61183e28a`)

## Context

Phase 12.4 adds a `clone:small-repo` benchmark that compares
`tsgit.clone` against `isomorphic-git.clone`. Both libraries clone
from a local `git-http-backend` CGI bound to `127.0.0.1`. Vitest
benchmarks call the timed function N times (default ~thousands of
samples up to a 500 ms budget). The lifecycle question is:

- **Option A — Boot CGI server once for the whole `describe`.** All
  iterations share the same `http.Server`. Each iteration spawns its
  own `git-http-backend` child via the request handler.
- **Option B — Boot a server per iteration.** Each bench iteration
  creates `http.createServer`, listens on an ephemeral port, runs
  the clone, then closes the server.

The trade-off is: what does the bench measure?

The CGI server in Option B carries ~50–100 ms of `listen()` +
`close()` overhead on every iteration — a baseline that exists in
the bench but not in the user-visible "clone latency" path. With a
clone that completes in ~30 ms for a 5-commit repo, that baseline
would dominate the signal.

Option A keeps the server boot **outside the measurement window**,
matching how real consumers experience clone time: the remote is
already listening when they call `clone`.

A secondary concern: the integration test
(`test/integration/network/clone-http-backend.test.ts`) already
proves the per-test CGI lifecycle works. Reusing the same handler
across bench iterations is a behaviour-preserving change.

## Decision

**Boot the `http.Server` once in `beforeAll` and close it in
`afterAll`. All bench iterations share the listener.** The CGI
process per request (`spawn('git-http-backend', ...)`) stays
per-iteration; only the listener socket is shared.

Tmpdir cleanup runs in `afterAll` (collected per-iter, swept once)
rather than inside each iteration, so the rm syscalls do not show
up in the sample distribution.

## Consequences

### Positive

- The bench measures clone latency, not CGI server boot. Signal-to-noise
  ratio is preserved on a 5-commit fixture where server boot would
  otherwise be 3× the clone itself.
- Matches how the equivalent isomorphic-git benchmarks would behave if
  isomorphic-git's project ever added one — apples-to-apples.
- Re-uses the existing CGI handler from the integration test (after
  extraction to `test/bench/support/http-backend-server.ts`),
  eliminating ~70 lines of duplicated CGI plumbing.

### Negative

- A single shared `http.Server` cannot be re-initialised mid-`describe`.
  If the server enters a bad state (e.g. a child process leaks an open
  fd), all subsequent iterations fail. Mitigation: each request spawns a
  fresh CGI child; nothing persists between requests on the server side.
- `afterAll` rm of N tmpdirs is sequential by default. We `Promise.all`
  the rm calls so cleanup is bounded by the slowest single rm, not
  N × slowest.

### Neutral

- Per-iteration tmpdir is unavoidable: `git.clone` requires an empty
  target. Each iter has to mkdtemp; that cost is in the measured region
  for both libraries.
- The Stryker skip is independent of this decision — mutation testing
  cannot drive the CGI child process across the `.stryker-tmp` sandbox
  boundary either way.

## Alternatives considered

- **Per-iteration server (Option B).** Rejected because listener boot
  dominates the measurement on a small fixture, defeating the bench's
  purpose.
- **Mock the HTTP transport.** Rejected because the BACKLOG acceptance
  text says "against a fixed local `git-http-backend` fixture" — the
  point is to measure the real wire format, not a mock.
- **External git-daemon on a known port.** Rejected because it would
  require a side-channel orchestration step before `npm run test:bench`,
  breaking the single-command UX every other bench file has.
