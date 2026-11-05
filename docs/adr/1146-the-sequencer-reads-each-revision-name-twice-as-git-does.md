---
subjects:
  - src/application/commands/internal/sequencer-revisions.ts
---
# 1146 — the sequencer reads each revision name twice, as git does

- **Status:** accepted
- **Date:** 2026-11-04
- **Design:** docs/design/rev-parse-corrupt-input.md · **Supersedes/Refines:** refines ADR-226

## Context

git's cherry-pick and revert resolve every argument in `setup_revisions` and again in
`sequencer_pick_revisions` (`sequencer.c`, the `repo_get_oid` before `can't cherry-pick a <type>`).
On a valid ambiguous name `x`, and on range sides such as `x..side` or `^x side`, the refname warning
prints twice and an unreadable fanout directory logs three times (pinned twice on 2.56.0); tsgit
resolves once and prints once.

## Options considered

1. **Re-read the name in `assertPicksCommit` with `evaluateRevision`, then peel; a non-commit or a
   peel fault refuses `CANNOT_PICK_NON_COMMIT` with the unpeeled type** — pros: the second warning,
   the third log and the unpeeled type all follow from git's own second read / cons: one extra ref read
   per seed. The designer's recommendation.
2. **Skip the second read** — cons: the warning and log counts diverge on the route this change
   rewrites.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `addSeed` resolves the plain name unpeeled
(`resolveCommitIshObject`), reads the named object (`BAD_OBJECT` on a read fault, ADR-1141), then
`assertPicksCommit` re-reads the name as git's second `repo_get_oid` does and peels it to a commit;
a non-commit or a peel fault refuses `CANNOT_PICK_NON_COMMIT { revision, type }` with the type of the
unpeeled object. All of it runs before `openReplayRun` writes any state.

## Consequences

- Warning and fanout-log counts match git on cherry-pick and revert, single, list and range forms.
- A tag pointing at a tree reports `type: 'tag'`, as git does, no longer `'tree'`.
