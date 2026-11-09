---
subjects:
  - src/domain/refs/loose-entry-name.ts
  - src/application/primitives/ref-store.ts
---
# 1160 — lock and dot-led names are skipped by the ref walk and the listing

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-294

## Context

`files_fsck_refs_dir` skips a basename ending in `.lock` unless it starts with `.`, and
`loose_fill_ref_dir`, git's loose-ref listing, skips every entry whose name starts with `.` or
ends with `.lock`. So `refs/heads/x.lock` holding garbage is neither judged nor listed: `git
fsck` exits 0 and `for-each-ref` and `branch` omit `y.lock` (C2, Q8); a dot-led `.x.lock`
under a linked admin dir is judged (`badRefName` and `badRefContent`) but never listed (Q9).
tsgit judges and lists both: C2 exits 10 and B7, the same shape under a linked admin dir,
exits 10 where git exits 0. The listing half reaches every consumer of `listRefNames` and
`listRefs`.

## Options considered

1. **Both halves: the integrity walk skips `*.lock` unless dot-led; the listing skips dot-led
   and `*.lock`** — pros: git-faithful end to end; two pure predicates / cons: the listing
   change reaches every listing consumer. The designer's recommendation.
2. **The walk only** — cons: B7 stays at exit 2 because the listing still zero-points
   `bad.lock`.
3. **Leave both out** — cons: B7, C2, Q8 and Q9 stay red.

## Decision

**Ratified by the user: option 1.** `src/domain/refs/loose-entry-name.ts` holds
`isSkippedByRefsVerify(basename)` (`!startsWith('.') && endsWith('.lock')`) and
`isSkippedByLooseIterator(basename)` (`startsWith('.') || endsWith('.lock')`). The integrity
walk applies the first to non-directory entries; `walkRefDir` applies the second to every
entry.

## Consequences

- `listRefNames`/`listRefs`, and every command built on them, no longer list `*.lock` or
  dot-led loose names; `rev-parse --verify refs/heads/y.lock` is refused as git's is (Q8).
- A dot-led `.x.lock` is still judged by fsck (Q9) and gets no pointer.
