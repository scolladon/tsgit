---
subjects:
  - src/domain/path/verify-path.ts
  - src/domain/objects/tree-entry-bytes.ts
---
# 1003 — The `.gitmodules` symlink check ports git's NTFS scan over the rest of the path

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/gitmodules-backslash-alias.md · **Supersedes/Refines:** refines ADR-978, applies ADR-763

## Context

git's `verify_path` runs `is_ntfs_dotgitmodules` at each component start and after every
backslash that is not the first byte of its component, on the rest of the WHOLE path: the
alias must be followed only by spaces and periods up to the end or a `:`. tsgit tested each
`/` component alone, never split on `\`, and used a narrow fall-back short-name regex.
Pinned against git 2.55 (3/3), three classes diverge for symlink entries: (A) `x\gitmod~1`
and its variants are admitted, (B) `gitmod~1/y`, `.gitmodules./y`, `gi7eba~1/y` are
refused, (C) `gi7eb~12`, `g~123456`, `~1234567` are admitted.

## Options considered

1. Fix all three classes with one port of git's scan (recommended).
2. Fix A only, file B and C.
3. Fix A and C, file B.

Matcher source: (a) import `matchesNtfsDotgitAlias` from `domain/objects/tree-entry-bytes.ts`
(recommended); (b) move the matchers to `domain/path`; (c) a string port in `verify-path.ts`.
Bytes when the caller passes none: (a) `encode(path)` on the symlink branch (recommended);
(b) a string-indexed matcher; (c) every caller passes bytes.

## Decision

**User-chosen** — option 1, all three classes. **Adopted-as-recommended** — matcher (a) and
bytes (a): one implementation of the grammar (ADR-763), and the grammar is pure ASCII so
encoding the decoded path is exact.

## Consequences

- `GITMOD_NTFS_SHORT_NAME` and `GITMOD_NTFS_HASHED_SHORT_NAME` go away.
- The comment claiming `validateIndexPath` rejects `\` is corrected.
- tsgit now admits the class-B paths that git admits: a less strict, faithful check.
