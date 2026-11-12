---
subjects:
  - src/application/commands/grep.ts
  - src/application/primitives/internal/peel.ts
phases: [design, review]
kind: trap
trigger: a fix reorders two refusals to match git, such as a bad rev against a bad pathspec
evidence:
  - test/integration/grep-interop.test.ts
  - src/application/commands/grep.ts
  - src/application/primitives/internal/peel.ts
source: { run: grep-blob-target, phase: review, date: 2026-11-12 }
status: active
supersedes: []
last-verified: 2026-11-12
---
# 036 — A refusal reorder probes a failure from every git stage

## Context

`grep` resolved its pathspec before its rev, so `HEAD:nope -- ../outside` reported the pathspec
where git reports the rev. The first fix moved the whole rev resolution ahead of the pathspec and
the next review round proved it over-corrected: git runs three stages — name resolution with the
object parse, then the pathspec, then the peel (`deref_tag`, a commit's tree) — and a failure in
the peel still loses to the pathspec. A forged commit naming a blob tree, a commit with a missing
tree and a tag with a missing target all refuse on the pathspec in git. The same round showed the
peel itself has two stages: tags are followed first, and only past a commit must the chain end on
a tree, refusing on the commit's id.

## Lesson

A refusal order is a sequence of stages, not a pair. Pinning the order with one failing input per
side proves only the stage that input reaches; the fix that makes it pass can move a later stage
across the other refusal.

## How to apply

Read git's code path for the command and list its stages in order before moving any refusal.
Pin one failing input per stage against the competing refusal, not one per side.
Build the late-stage inputs with `git hash-object --literally` in a throwaway repository.
Assert the refusal's identifying datum (which id or name git prints), not only its code.

## Evidence

`test/integration/grep-interop.test.ts` — the "refused before the pathspec" rows (a missing path,
a missing object) and the "fails only once peeled" rows (commit naming a blob tree, commit with a
missing tree, tag with a missing target), each against `-- ../outside`.
`src/application/commands/grep.ts` — `grepRev`: `resolveReference`, then the pathspec, then
`peelToTreeOrBlob`.
`src/application/primitives/internal/peel.ts` — `peelToTreeOrBlob` and `rootTreeOf`: the tag walk,
then the commit's root read refusing on the commit.
