---
subjects:
  - test/bench/support/scaled-bench.ts
  - test/bench/support/fixture-generator.ts
  - tooling/profile.ts
  - tooling/bench-memory.ts
---
# 798 — Scaled benches skip only when the fixture is unavailable

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/fix-main-ci-bench-fixture-deps.md (scope fold) · **Supersedes/Refines:** none

## Context

`resolveScaledContext` wraps `ensureScaledFixture` in a bare `catch` that returns a context
with no fixture, which `scaledScenario` turns into a skipped scenario. The documented reason
to skip is that the fixture cannot be built at all: no `git` on `PATH`, or the Stryker
sandbox. The bare `catch` also swallows a failed `fast-import`, a failed rename, a thrown
identity mismatch and every programming error, each of which then appears as a benchmark row
that silently stopped existing. The design named this as a latent defect outside the two red
jobs; the user ruled that it rides in this change rather than being left as a follow-up.

## Options considered

1. **Narrow the `catch` to the unavailable-fixture condition and rethrow everything else**
   (orchestrator's recommendation) — pros: a broken generator fails the bench file loudly;
   the skip keeps its documented meaning / cons: `FixtureUnavailableError` (or a type guard
   for it) must be exported from the generator module.
2. **Leave the bare `catch`** — cons: every future generator defect hides as a missing row.
3. **Log and skip** — cons: the row still vanishes from the snapshot series; a log line in a
   30-minute CI log is not a signal.

## Decision

**Ratified by the user: option 1.** `resolveScaledContext` skips a scenario only when
`ensureScaledFixture` reports the fixture unavailable (the exported unavailable-fixture
condition) or when running under Stryker; any other error propagates and fails the bench file.
The generator exports the narrowing predicate rather than asking callers to inspect messages.

The two profiling tools that resolve the same fixtures, `tooling/profile.ts` and
`tooling/bench-memory.ts`, narrow their own `catch` with the same predicate (adopted as
recommended in the design's revision, no user judgment): the "install the `git` CLI" message
is printed only for the unavailable condition, and every other error surfaces with its own
message. Both already exit non-zero on every failure, so the change is to the diagnosis, not
to the exit status.

## Consequences

- A generator regression is a red `test:bench`, not a shorter benchmark table.
- `tooling/gen-bench-fixture.ts` already lets errors propagate through its top-level
  `main().catch`. The profiling and memory tools did not: each relabelled every failure as a
  missing `git`; with the shared predicate all four callers of the generator agree.
