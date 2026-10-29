---
subjects:
  - src/application/commands/internal/staged-patch.ts
  - src/domain/diff/apply-hunks.ts
  - docs/adr/1103-the-stashed-index-is-judged-by-git-s-patch-rule.md
phases: [design, decisions, review]
kind: gotcha
trigger: a git command whose C source pipes one plumbing command into another is modelled with a merge
evidence:
  - src/application/commands/internal/staged-patch.ts
  - src/domain/diff/apply-hunks.ts
  - test/integration/stash-apply-index-judge-interop.test.ts
source: { run: stash-apply-dir-file-replacement, phase: review, date: 2026-10-27 }
status: active
supersedes: []
last-verified: 2026-10-29
---
# 021 — `stash apply --index` applies a patch, it does not merge

## Context

The design modelled the stashed index's reinstatement as a three-way merge of the base, the
stashed index and the current index: it agreed with git on every ordinary shape the first probe
matrix held. git's `do_apply_stash` runs `diff-tree --binary B I | apply --cached` instead. A
reviewer's probe found five shapes where the two disagree, among them git's own documented
`stash push --keep-index` → `commit` → `stash pop --index` flow, which the merge accepted and
git refuses. The judge was rewritten as a port of `apply.c`: exact three-line context, the
forward-first outward offset search, line-one and end anchoring, the creation, deletion, binary
and mode rules, and the two-phase write whose first failing path is the one git names.

## Lesson

When git's own source composes plumbing, the plumbing's rules are the behaviour. A merge that
reproduces the common shapes is a different algorithm, and the shapes where it differs are the
ones git documents.

## How to apply

Read the C function behind the command before designing; name each plumbing step it runs.
Port that step's rules (here `apply.c`: context, offsets, anchoring, binary, mode), not a
primitive that happens to agree on the first matrix.
Probe the shapes git's documentation names for the command, not only the ones the brief names.

## Evidence

- `src/application/commands/internal/staged-patch.ts`, `judgeStagedPatch`: the check phase
  over every changed path, then the clash walk in write order.
- `src/domain/diff/apply-hunks.ts`, `applyDiffOnto`: `apply.c` at its defaults over the
  repository's own hunks.
- `test/integration/stash-apply-index-judge-interop.test.ts`: the `--keep-index` flow, the
  offset, anchoring, deletion, binary and mode rows, each refused or applied as git 2.55.0 does.
