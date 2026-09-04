---
subjects:
  - test/bench/support/fixture-generator.ts
---
# 794 — `FIXTURE_GENERATOR_VERSION` stays at 3

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/fix-main-ci-bench-fixture-deps.md (D4) · **Supersedes/Refines:** refines ADR-054

## Context

The brief asked for a bump to 4 on the premise that the CI cache held a truncated fixture.
Verification showed the cached entry pristine: it was restored and green on eight consecutive
`main` runs before the mutating bench landed. The constant's own contract is "bumped whenever
the fixture shape changes", and the shape does not change here. The `actions/cache` key is a
hash of the generator file, which ADR-793's guard edits anyway.

## Options considered

1. **Do not bump** (designer's recommendation) — pros: the constant keeps meaning what it
   says; the CI key is already invalidated by the guard edit; every developer's `-v3` caches
   stay valid and the guard repairs the one mutated directory / cons: none found.
2. **Bump to 4 as briefed** — pros: documents an intent / cons: the intent rested on a
   falsified mechanism; forces a cold rebuild of every local fixture including the
   70 000-commit `header-cache`; buys no CI invalidation the guard edit does not already cause.

## Decision

**Ratified by the user: option 1.** The version constant is bumped only for a fixture shape
change, never to invalidate a cache for another reason; cache invalidation on CI is a
consequence of editing the generator file, and local repair is the identity guard's job.

## Consequences

- Local `-v3` caches remain valid; the reclaim of older version directories is a separate
  ruling (ADR-799).
- Anyone reading `FIXTURE_GENERATOR_VERSION`'s history sees only shape changes.
