---
subjects:
  - src/domain/fsck/validate-tree.ts
  - src/domain/objects/tree-entry-bytes.ts
---
# 763 — fsck implements git's dotgit alias matrix

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (review round 1, Out of scope → promoted) · **Supersedes/Refines:** none

## Context

`fsck` compared the seven names it cares about — `.`, `..`, `.git`, `.gitmodules`,
`.gitattributes`, `.gitignore`, `.mailmap` — against a decoded string. Making those
comparisons byte-exact was correct, and it removed two false positives measured against
git. It also **lost** protections git has, because the old decoder stripped one leading
byte-order mark by accident and that accident was doing real work.

Quantified by review: git flags `hasDotgit` for `.git`, for a mark-prefixed `.git`, for
`.GIT`, and for `git~1`. Before this branch tsgit caught the first two; after, only the
first. The accidental coverage was 1 of git's 13 HFS-ignorable code points, at the leading
position only, and none of the NTFS or case-fold matrices — so the branch widened a gap
that was already about 99% open rather than opening a new one. It is still a loss on a
security-relevant check, and it was made by this change.

git's own rule is three matrices: `is_hfs_dotgit` folds 13 ignorable code points at any
position; `is_ntfs_dotgit` catches the 8.3 short name and stream-suffix forms; and the
comparison is case-insensitive.

## Options considered

1. **Accept the loss and record it** — pros: bounded, honest, keeps this change's size / cons: knowingly ships less protection than the branch started with, on a path-traversal-adjacent check.
2. **Restore only the leading-mark fold** — pros: small, restores exactly what was lost / cons: re-introduces one arbitrary special case into code just made principled, and still leaves 12 of 13 code points and both other matrices uncovered.
3. **Implement the full matrix** — pros: real parity with git, closes a gap that predates this work / cons: a feature in its own right, growing an already-large change.

## Decision

**Ratified by the user: option 3.** `fsck` folds names the way git does before comparing
them against the seven literals: the HFS-ignorable code points at any position, the NTFS
short-name and stream-suffix forms, and case. The fold is a byte-level operation in the
shared entry-bytes module, so it is testable on its own and has one implementation.

The fold applies **only** to the alias comparisons. Everything else this change made
byte-exact — the duplicate key, the sort key, the length count — stays byte-exact, because
git compares those as raw bytes too.

## Consequences

### Positive

- `.GIT`, `git~1` and mark-obfuscated forms are reported, none of which tsgit ever caught — this ends net ahead of where the branch started, not merely level.
- The fold is one tested function rather than an emergent property of a decoder.

### Negative

- Materially more code and test surface in a change that was already wide. The alias matrix is pinned row by row against real git in the interop suite rather than asserted from git's source.
