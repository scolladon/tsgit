---
subjects:
  - src/application/primitives/internal/scan-tracked-entries.ts
  - src/application/primitives/internal/smudge-racily-clean.ts
  - src/application/commands/mv.ts
phases: [design, implementation, review]
kind: gotcha
trigger: a change adds or widens a pass that compares, refreshes or smudges index entries
evidence:
  - src/application/primitives/internal/scan-tracked-entries.ts:99
  - src/application/commands/mv.ts:361
  - test/integration/whole-second-stat-match-interop.test.ts:931
  - test/integration/whole-second-stat-match-interop.test.ts:991
source: { run: whole-second-stat-match, phase: review, date: 2026-11-25 }
status: active
supersedes: []
last-verified: 2026-11-25
---
# 060 — A pass that compares or smudges entries takes git's leave-alone arms

## Context

The design wrote git's ordered list for `ie_match_stat` and pinned one row per branch for the
judges that read the index. Review then found, in two separate rounds, a writer that ignored
the list's first arm. The index write `status` makes smudged a racy skip-worktree entry whose
file had been rewritten at the same size; git's refresh marks a skip-worktree entry up to date
and never smudges it. One round later the new refresh in `mv` compared a moved skip-worktree
entry and recorded size 0 where git keeps the entry as it is. Both were one-line omissions:
the scan's verified set lacked the skip-worktree paths, and `settleMoved` lacked an early
return.

## Lesson

The arms git returns on before any `lstat` hold for the passes that write the index as much as
for the judge that reads it. A new pass inherits none of them.

## How to apply

When a pass compares, refreshes or smudges entries, list the arms git's routine at that step returns on before it stats.
Pin one interop row per arm per pass: rewrite the file at the same size in the index second, run the command, compare the recorded size with git's.
Carry the arms as data, in the verified set handed to the index write, so a new pass cannot forget one.
Lesson 046 holds the ordered list for the judge itself.

## Evidence

`src/application/primitives/internal/scan-tracked-entries.ts:99` — `leftAloneIn` and `verifiedBy`:
the skip-worktree paths join the paths the scan found unchanged.
`src/application/commands/mv.ts:361` — `settleMoved` returns a skip-worktree entry untouched.
`test/integration/whole-second-stat-match-interop.test.ts:931` and `:991` — the moved
skip-worktree row and the `status` and `add` rows, each red before its fix.
