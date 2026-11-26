---
subjects:
  - src/application/primitives/internal/is-entry-stat-clean.ts
  - src/application/primitives/internal/smudge-racily-clean.ts
  - src/application/commands/mv.ts
phases: [design, review]
kind: trap
trigger: a fix removes a field or a precision from the stat compare every index reader shares
evidence:
  - src/application/commands/mv.ts:361
  - test/integration/whole-second-stat-match-interop.test.ts:851
  - docs/adr/1268-a-moved-entry-is-refreshed-and-stays-a-smudge-candidate.md
source: { run: whole-second-stat-match, phase: review, date: 2026-11-25 }
status: active
supersedes: []
last-verified: 2026-11-25
---
# 059 — A compare that drops a field is re-checked at every writer that leaned on it

## Context

The stat compare stopped counting nanoseconds, and ctime and inode where the config says so, as
git's `match_stat_data` does. Every reader was re-pinned against git. `mv` was on no list: it
copied the source entry to the new path as it was. Before the change a moved entry never
matched its file, because the rename moved the ctime, so the next reader read the content.
Under `core.trustCtime=false` or `core.checkStat=minimal` the rename's ctime stopped counting.
A file edited at the same size in the second it was staged, then moved, read as clean where git
reports it modified. The index write did not smudge the moved entry either: it picked its
candidates by path. The security reviewer's probe found it in the first cycle. git refreshes
the moved entry in `rename_index_entry_at`.

## Lesson

A field of a shared compare can be the only thing that makes a writer's stale entry visible
afterwards. Dropping it from the compare removes that net at writers the readers' matrix never
names.

## How to apply

List every command that writes an index entry without comparing its content (`mv`, a re-stage in `add`, a refresh, a sparse mover).
For each, name the field that made a later reader mismatch, and git's routine at that step.
Pin a same-size edit in the staging second per writer, under `core.trustCtime=false` and `core.checkStat=minimal`.
Key a pass over racy entries on the stat data the index was read with, never on the path.

## Evidence

`src/application/commands/mv.ts:361` — `settleMoved` and `refreshMoved`: a moved entry is
compared at its new path, and only an unchanged one is handed to the index write as verified.
`test/integration/whole-second-stat-match-interop.test.ts:851` — "a file edited at the same size
in the second it was staged is moved", under both policies and both `core.ignorecase` values; red
before the fix.
`docs/adr/1268-a-moved-entry-is-refreshed-and-stays-a-smudge-candidate.md` — the rule and git's
routine.

<!-- cspell:ignore trustctime checkstat -->
