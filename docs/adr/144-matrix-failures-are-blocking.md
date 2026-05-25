# ADR-144: Runtime-parity matrix failures are blocking

## Status

Accepted (at `4911c0d`)

## Context

When a CI job is informational rather than blocking, it carries
`continue-on-error: true` (see `benchmark-compare` — same-runner
benchmarking is too noisy to gate on, so flagged regressions surface as
a PR comment but never fail the workflow).

The runtime-parity matrix could in principle adopt the same posture
("Deno failed but the matrix is informative; the merge is allowed").
That would let regressions into a runtime ship silently, only surfaced
by the next user who tries that runtime.

Two reasons that posture is wrong for 19.8:

1. **The README claim is load-bearing.** Once the matrix is green, the
   README opener lists Deno/Bun/Workers under "Cross-runtime". A
   non-blocking matrix means the README can claim cross-runtime support
   that CI no longer enforces.
2. **Runtime regressions are real bugs, not noise.** Unlike benchmark
   variance, a Deno or Bun test failure is binary: either the scenario
   matches the golden or it doesn't. There is no measurement noise to
   hide behind.

## Decision

All three runtime-parity jobs (`parity-deno`, `parity-bun`,
`parity-workers`) are **blocking**:

- No `continue-on-error: true`.
- No "informational mode" period before promoting to blocking.
- A failure in any matrix cell fails the CI workflow and blocks merge.

The README's `Cross-runtime` claim is updated to list the new runtimes
in the **same PR** that introduces the matrix; if any matrix cell is
red, the README change is reverted in the same PR. The README's claim is
true iff the matrix is green.

## Consequences

### Positive

- The `Cross-runtime` README line cannot become a lie via silent
  regression.
- Cross-runtime regressions are caught at PR review, not at user
  install time.
- Treating runtime support seriously matches how Node, Browser, and
  Memory adapters are gated today (those tests are also blocking).

### Negative

- A flaky runtime (e.g. Deno's npm resolver transient errors) blocks
  merges. Mitigated by: (a) `fail-fast: false` so one runtime's flake
  doesn't mask another's signal; (b) standard CI re-run if a flake is
  confirmed.
- Adding a new scenario means proving it works on every runtime — a
  small per-PR cost, but exactly the cost the matrix is designed to
  impose.

### Neutral

- If a runtime's tooling has a multi-week outage (Cloudflare's pool
  breaking, etc.), the job can be temporarily disabled in CI with a
  documented tracking issue. That's a one-off operational call, not a
  default posture.
