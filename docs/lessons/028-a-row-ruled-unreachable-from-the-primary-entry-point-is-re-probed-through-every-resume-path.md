---
subjects:
  - src/application/commands/rebase.ts
  - src/application/commands/internal/commit-ish.ts
  - src/application/commands/internal/sequencer-revisions.ts
  - test/integration/commit-ish-corrupt-candidate-interop.test.ts
phases: [design, review]
kind: gotcha
trigger: a design or review row is ruled unreachable because the command's primary entry point filters the input that would reach it
evidence:
  - test/integration/commit-ish-corrupt-candidate-interop.test.ts
  - docs/design/rev-parse-corrupt-input.md
  - src/application/commands/rebase.ts
source: { run: rev-parse-corrupt-input, phase: review, date: 2026-11-05 }
status: active
supersedes: []
last-verified: 2026-11-05
---
# 028 — A row ruled unreachable from the primary entry point is re-probed through every resume path

## Context

The design's faithfulness matrix carried a rebase row, todo `reset x` with `x` a corrupt tag,
and the review ruled it unreachable: `rebaseRun`'s `interactive` input takes pick-family
instructions only, and `rebaseMerges` with instructions is refused. The tests reviewer then
probed the other way in: a rebase-merges run stopped on a conflict, its remaining todo
hand-edited on disk to `reset x` (git's `--edit-todo` workflow), then `rebaseContinue`. The
row was reachable, git had a behaviour there to pin (one ambiguity warning, `error: could not
resolve 'x'`, `rebase-merge/` kept), and the ruled-out line had to be revised and the twin
row written in a late fix batch.

## Lesson

An on-disk state file is an input surface. A resume, skip, abort or edit entry point re-reads
what the primary wrote without the primary's input filter, so "the primary cannot produce it"
proves nothing about reachability.

## How to apply

Before writing "unreachable", list every entry point that re-reads state the primary wrote: continue, skip, abort, edit-todo, the sequencer's `todo`.
Probe each with real git on a fixture that stops the run there (a conflict), with `user.*` set and `GIT_EDITOR=true`.
Pin the reachable ones as twin rows on both tools, state files included.
A ruled-out line a later probe overturns is rewritten as `RULED-OUT-REVISED` with the new proof, never silently dropped.

## Evidence

`test/integration/commit-ish-corrupt-candidate-interop.test.ts` — the reset-x-through-continue row: a conflict-stopped rebase-merges run, its todo hand-edited, `continue` on both tools.
`docs/design/rev-parse-corrupt-input.md` — the matrix row "rebase -i, todo reset x", revised from "unreachable" to "reachable only through rebaseContinue after a hand-edited rebase-merges todo".
`src/application/commands/rebase.ts` — `rebaseContinue` re-reads `rebase-merge/git-rebase-todo` with no instruction-kind filter.
