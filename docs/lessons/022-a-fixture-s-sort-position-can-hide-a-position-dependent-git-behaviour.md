---
subjects:
  - test/integration/stash-push-reset-interop.test.ts
  - test/integration/occupant-displacement-fixtures.ts
  - src/application/commands/stash.ts
phases: [implementation, review]
kind: gotcha
trigger: a cross-tool twin and a hand probe of the same shape disagree, both against the same git
evidence:
  - test/integration/stash-push-reset-interop.test.ts
  - test/integration/occupant-displacement-fixtures.ts
  - docs/adr/1106-stash-push-keeps-the-index-id-of-a-same-gitlink-type-change-that-leads-its-diff.md
source: { run: stash-apply-dir-file-replacement, phase: review, date: 2026-10-28 }
status: active
supersedes: []
last-verified: 2026-10-28
---
# 022 — a fixture's sort position can hide a position-dependent git behaviour

## Context

A fold made `stash push` record the file standing at a gitlink's path. The implementer's twins, seeded with the
harness's gitlink `sub`, showed git recording the occupant; the session's probe, seeded with `f`, showed git
keeping the gitlink. Both were right: git 2.55 and 2.56 leave a same-gitlink type change out of the stash's
working-tree diff only when it is the first changed path in index order, and `sub` sorts after every other
fixture file while `f` sorted first. A review round, a hand replay of git's `update-index` step and five probes
were needed before the two results were seen as one rule.

## Lesson

A twin pins a shape at one point of git's input order. When git's behaviour depends on where a path sits among
the changed paths, one fixture position proves one branch and silently hides the other; two correct experiments
then look contradictory.

## How to apply

When a twin and a probe of the same shape disagree, diff their seedings before doubting either; vary one axis at a
time and keep the sort position of the path on the list.
Seed every new shape twice, with the path sorting first and last among the changed paths.
Name the position in the row title when it matters.

## Evidence

- `test/integration/occupant-displacement-fixtures.ts`: the harness seeds `keep` and the fixture files, so a
  gitlink named `sub` is always the last changed path.
- `test/integration/stash-push-reset-interop.test.ts`: the same-gitlink projection rows, seeded first and last.
- `docs/adr/1106-stash-push-keeps-the-index-id-of-a-same-gitlink-type-change-that-leads-its-diff.md`: the rule
  and the probes that pinned it.
