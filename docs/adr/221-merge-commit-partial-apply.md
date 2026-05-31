# ADR-221: git-faithful partial-apply for merge commits in a range

## Status

Accepted (at `b4faeceb`)

## Context

Without `-m` (deferred, ADR-219), a merge commit (≥2 parents) cannot be
cherry-picked — there is no single base. When a *range* contains a merge commit,
two behaviours are possible:

1. **Upfront reject (validate-all-then-execute)** — scan the whole range first;
   if any commit is a merge, throw before applying anything. Atomic; matches the
   tsgit `mv`/`rm`/`stash` idiom.
2. **Partial-apply (git-faithful)** — apply and commit every non-merge commit up
   to the merge, then stop *at* the merge, leaving a resumable sequencer state.

Verified: real git does (2) — it commits the earlier picks, then errors "is a
merge but no -m option was given", leaving `.git/sequencer/todo` with the merge
as line 0 and **no** `CHERRY_PICK_HEAD`.

## Decision

**Partial-apply (option 2)**, matching git exactly. `runSequence` applies and
commits non-merge commits in order; on reaching a merge commit it writes the
sequencer state (`todo[0]` = merge, `head`, `abort-safety`, `opts`; no
`CHERRY_PICK_HEAD`) and throws `CHERRY_PICK_MERGE_NO_MAINLINE`. The user resumes
with `skip` (drop the merge) or `abort` (reset to pre-sequence HEAD). A *single*
merge-commit pick throws immediately with no sequencer dir (matches git).

## Consequences

### Positive

- Byte-faithful to git, including the cross-tool resume contract (ADR-218): git
  can `--skip`/`--abort` a tsgit partial-apply and vice-versa.

### Negative

- Diverges from tsgit's usual atomic validate-all-then-execute: a refusal leaves
  the earlier picks committed (a partial result). Justified by faithfulness +
  full resumability (the partial state is recoverable, not lost).

### Neutral

- Reuses the same `isMergeCommit` guard in the `-n` path, which throws without
  persisting any state (ADR-219).
