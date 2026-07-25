# 504 — Non-hot bench coverage: medium-only reads and writes for all profiled commands

- **Status:** accepted (user judgment — ratified including the write benches in this change
  over deferring or dropping them)
- **Date:** 2026-07-24
- **Design:** docs/design/bench-hot-path-rework.md · **Relates:**
  [ADR-501](501-hot-path-picking-methodology.md) (hot vs non-hot),
  [ADR-476](476-profiler-command-registry-scope.md) (the profiled-command set)

## Context

"Non-hot paths keep medium only." Four profiled **read** commands have no bench today
(`show`, `diff`, `cat-file`, `rev-parse`); three profiled **write** commands have none either
(`commit`, `add`, `merge`). A medium read bench loops in place on the shared medium fixture
(cheap). A medium write bench cannot loop in place — each invocation mutates repo state — so
it needs a **fresh-scratch-repo-per-iteration** harness at medium scale, i.e. the 26.3
`profile-scratch-repo.ts` factory (`buildCommitScratch`/`buildAddScratch`/`buildMergeScratch`)
adapted to a bench. That is materially heavier than a read loop, which is why the write scope
was escalated to the user rather than silently bundled or dropped.

## Options considered

1. **Add medium reads now; include the write benches now (reusing the 26.3 scratch factory);
   `clone`/`delta-chain` stay non-gated** — complete profiled-command coverage in one change.
   / pros: no un-benched profiled command; matches the repo's no-silent-follow-ups default.
   / cons: heavier implementation (the write-scratch harness).
2. **Reads now, defer writes** to a backlog follow-up. / pros: lighter PR. / cons: leaves the
   write path un-benched; adds a follow-up the default discourages.
3. **Reads only, writes out of scope entirely.** / cons: permanently drops write-bench
   coverage.

## Decision

Add **medium-only** benches for **all** un-benched profiled commands in this change:

- **Reads** (`show`, `diff`, `cat-file`, `rev-parse`) — loop-in-place on the medium fixture.
- **Writes** (`commit`, `add`, `merge`) — a **fresh-scratch-repo-per-iteration** harness at
  medium scale, reusing the 26.3 scratch-repo factory.

These are **non-hot** (ADR-501): medium tier only, **not** size-tiered. `clone` stays its
single network-bound scenario (network dominates, not repo size); `delta-chain-read` stays a
medium-only worst-case shape stressor. Neither `clone` nor `delta-chain-read` is gated (they
are inherently higher-variance than a representative medium read).

## Consequences

- Every profiled command (ADR-476 registry) has a bench after this change — no un-benched
  profiled surface remains.
- The write benches carry the heavier per-iteration scratch cost; they run on the medium
  fixture only and are excluded from the hot-path gate (they are not in the registry).
- No deferred follow-up is filed for write benches — the coverage lands here.
