---
subjects:
  - src/application/commands/mv.ts
  - src/application/primitives/internal/smudge-racily-clean.ts
  - src/application/primitives/internal/index-lock.ts
phases: [design, review, validation]
kind: trap
trigger: a change makes the index write do more to entries the command does not own, such as a wider racy smudge
evidence:
  - src/application/commands/mv.ts:248
  - test/integration/whole-second-stat-match-interop.test.ts:881
  - test/integration/whole-second-stat-match-interop.test.ts:909
  - docs/adr/1270-mv-writes-the-index-only-when-an-entry-moved.md
source: { run: whole-second-stat-match, phase: validation, date: 2026-11-25 }
status: active
supersedes: []
last-verified: 2026-11-25
---
# 063 — A write git skips stops being neutral once the index write smudges

## Context

`mv` committed the index lock on every run, also when `-k` skipped every source and nothing
moved. git ends `cmd_mv` with `write_locked_index(…, COMMIT_LOCK | SKIP_IF_UNCHANGED)` and
writes nothing then. On main the extra write was almost invisible: same bytes, new file times,
and an empty index created where none existed. This change made the index write smudge by
whole seconds, so the same extra write now recorded size 0 for a file edited in the second it
was staged, where git leaves the index alone. The review rounds missed it. It surfaced in
mutation triage, from a static mutant Stryker ignores, applied by hand: nothing failed, and
asking when that value is ever written led to the probe.

## Lesson

A command that writes the index where git skips the write is a latent divergence. A change
that makes the write smudge, refresh or reorder more turns every such command into a visible
one, far from the code the change edits.

## How to apply

List the commands that commit the index lock, and read for each whether git passes `SKIP_IF_UNCHANGED`.
Run each with an input that changes nothing, after a same-size edit in the staging second.
Compare the index bytes, its mtime and its existence with git's, under both `core.ignorecase` values.
Fold the ones that differ in the change that made them visible.
Apply a reviewer-predicted static mutant by hand: Stryker's `ignoreStatic` never reports it.

## Evidence

`src/application/commands/mv.ts:248` — the lock is committed only when an entry moved.
`test/integration/whole-second-stat-match-interop.test.ts:881` and `:909` — the two rows, under
both `core.ignorecase` values, red before the fix.
`docs/adr/1270-mv-writes-the-index-only-when-an-entry-moved.md` — git's source line and the
three probed shapes. `add` of an unchanged path, `checkout` of another path and both no-op
resets were probed the same way and match git.
