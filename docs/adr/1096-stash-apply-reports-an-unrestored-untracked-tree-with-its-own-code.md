---
subjects:
  - src/application/commands/stash.ts
  - src/domain/commands/error.ts
---
# 1096 — `stash apply` reports an unrestored untracked tree with its own error code

- **Status:** accepted
- **Date:** 2026-10-27
- **Design:** docs/design/stash-apply-dir-file-replacement.md (DC1, F4–F6) · **Supersedes/Refines:** refines ADR-212

## Context

git's `stash apply` merges the stashed work tree first and restores the stash's untracked files afterwards,
through `checkout-index --all` without `--force`. When a path already exists it prints `<p> already exists, no
checkout` and keeps going; when a leading component is a file or a symlink it dies `fatal: cannot create directory
at '<dir>': File exists` and stops. Either way it exits 1 with the merge already written, and `pop` keeps the stash
(A.3 UP rows, A.1 LD × `-u`). tsgit refuses before the merge with `STASH_APPLY_WOULD_OVERWRITE`, a code ADR-212
defines as atomic: nothing written. Once the restore moves after the merge, that code cannot describe a failure that
follows a written merge.

## Options considered

1. **A new code `STASH_UNTRACKED_NOT_RESTORED { existing, blockedAt? }`** (designer's recommendation) — pros: the
   refusal code keeps its "nothing written" meaning; `existing` and `blockedAt` let a caller rebuild both git
   messages (ADR-249); `pop` keeps the stash as git does / cons: a new error code, an additive `api.json` change.
2. **Reuse `STASH_APPLY_WOULD_OVERWRITE { paths }` after the merge** — pros: no new code / cons: a code meaning
   "nothing written" would be thrown after the merge was written, misleading every caller that relies on ADR-212.
3. **Return `kind: 'applied'` with an `untrackedNotRestored` field** — pros: no throw / cons: `pop` drops only on
   `applied`, so it would drop a stash git keeps.

## Decision

**User-ratified: option 1.** A clean merge whose untracked restore left something unwritten throws
`STASH_UNTRACKED_NOT_RESTORED { existing, blockedAt? }`: `existing` lists, in index order, every path that already
existed and was not written; `blockedAt` names the leading component (the directory git names, not the entry) that
stopped the restore, when one did. The merge's index and work tree stay as written. `pop` keeps the stash.

## Consequences

- `STASH_APPLY_WOULD_OVERWRITE` stays atomic for the tracked merge (ADR-212 holds); the untracked restore is a
  separate, later step with its own failure code.
- `reports/api.json` gains the code and its data; `domain/error.ts` gains a message case (wording only, ADR-249).
- A caller rendering git's stderr rebuilds `<p> already exists, no checkout` per `existing`, then
  `fatal: cannot create directory at '<blockedAt>': File exists` when set, then
  `error: could not restore untracked files from stash`.
