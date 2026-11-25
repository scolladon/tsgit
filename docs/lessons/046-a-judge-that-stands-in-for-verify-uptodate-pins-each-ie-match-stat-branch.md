---
subjects:
  - src/application/primitives/internal/sparse-left-dirty.ts
  - test/integration/sequencer-sparse-cone-writes-interop.test.ts
  - src/application/primitives/compare-working-tree-entry.ts
  - test/integration/directory-at-tracked-path-interop.test.ts
phases: [design, planning, review]
kind: gotcha
trigger: a change writes its own "is this out-of-pattern file up to date" check in place of git's verify_uptodate
evidence:
  - src/application/primitives/internal/sparse-left-dirty.ts
  - test/integration/sequencer-sparse-cone-writes-interop.test.ts
  - src/application/primitives/compare-working-tree-entry.ts
  - test/integration/directory-at-tracked-path-interop.test.ts
source: { run: sequencer-sparse-cone-writes, phase: review, date: 2026-11-19 }
status: active
supersedes: []
last-verified: 2026-11-25
---
# 046 — A judge that stands in for verify_uptodate pins each ie_match_stat branch

## Context

The sparse mover judge started as a content compare. Three review cycles each found a branch of
git's `verify_uptodate_1` → `ie_match_stat` it skipped: a mode or type change (exec bit honouring
`core.filemode`, a link checked out as a file under `core.symlinks=false`), a directory or other
occupant, a symlinked leading directory, and the lstat itself — git lstats first, so an absent
file behind a link is up to date while ENOTDIR is left and warned. Each miss either deleted a
file git keeps or kept one git retires.

The core.fileMode run repeated it at the shared comparison seam: three review cycles and two
feature rounds found, one per round, a directory at a tracked path, assume-unchanged trust, the
stale-stat refusal of an assume-unchanged entry, and the stat fields `core.trustCtime` and
`core.checkStat` narrow.

## Lesson

git's up-to-date check is an ordered decision list, not a hash compare. A replacement that
skips one branch diverges on exactly the shapes that branch exists for.

## How to apply

Before planning, write the judge's order from `verify_uptodate_1` and `ce_match_stat_basic`:
lstat (ENOENT, other errno), occupant kind, leading symlink, CE_VALID, mode/type, stat fields
(whole seconds, ctime under `core.trustCtime`, owner/inode unless `core.checkStat=minimal`), content.
Pin one interop row per branch, under both `core.ignorecase` twins, before the review starts.
Read the config a branch depends on (`core.filemode`, `core.symlinks`) lazily, so a stat-clean path stays free.
See lesson 019 for which git routine a caller's judge must follow.

## Evidence

- `src/application/primitives/internal/sparse-left-dirty.ts`, `verdictOf` and `modeDiffers`:
  the ordered list as shipped.
- `test/integration/sequencer-sparse-cone-writes-interop.test.ts`, the mover rows
  (`executable-mover-kept`, `mover-behind-dangling-symlink-retired`, `mover-under-a-file-kept`,
  `symlink-mover-as-file-removed-when-symlinks-off`, `executable-mover-removed-when-filemode-off`).
- `src/application/primitives/compare-working-tree-entry.ts`, `compareAndRefresh`, and
  `test/integration/directory-at-tracked-path-interop.test.ts`: the same list at the seam every
  status/add/rm/stash/overwrite caller shares.

<!-- cspell:ignore uptodate errno filemode checkstat trustctime -->
