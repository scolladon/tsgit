---
subjects:
  - tooling/gen-bench-fixture.ts
  - test/bench/support/fixture-prune.ts
---
# 799 — Stale fixture caches are reclaimed only on an explicit prune

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/fix-main-ci-bench-fixture-deps.md (scope fold) · **Supersedes/Refines:** refines ADR-054

## Context

Every `FIXTURE_GENERATOR_VERSION` bump leaves the previous `<label>-v<N>` directories behind,
and nothing reclaims them: one developer machine holds 2.0 GB across `v1`, `v2` and `v3`.
ADR-793's retire step and the temp-build path can also leave `*.corrupt.*` or `*.tmp.*`
directories if a process dies mid-way. The user ruled that reclaim rides in this change. The
hazard with any automatic sweep is concurrency across worktrees: two checkouts at different
generator versions running benches at the same time would delete each other's live fixtures.

## Options considered

1. **Explicit opt-in: `npm run bench:fixture -- --prune`** (orchestrator's recommendation) —
   pros: nothing deletes a directory another process might be using; the tool lists what it
   removed and the bytes reclaimed / cons: developers must remember to run it.
2. **Automatic on the first resolution per process** — cons: a `v3` bench run in one worktree
   deletes the `v4` fixtures a sibling worktree is benchmarking, and the reverse.
3. **Automatic with a 30-day age gate** — cons: narrows the hazard without removing it and adds
   a time rule to test and a magic number to justify.

## Decision

**Ratified by the user: option 1.** The pre-warm tool gains a `--prune` verb that removes,
under the cache root, every known-label `<label>-v<N>` directory whose `N` differs from the
current version and every leftover `*.tmp.*` or `*.corrupt.*` build directory, then prints
each removed path and the total bytes reclaimed. Directories at the current version are never
touched. No code path deletes a cache directory automatically except ADR-793's replacement of a
directory that failed its identity probe.

## Consequences

- Reclaim is a deliberate developer action, documented beside the pre-warm command.
- The prune logic lives outside the hashed generator file so its edits never invalidate the CI
  fixture cache; it reads the version constant and cache root from the generator.
- The nightly never prunes: runner caches are keyed per generator hash and expire on their own.
