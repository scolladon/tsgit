---
subjects:
  - src/domain/objects/tree-entry-bytes.ts
  - src/domain/fsck/validate-tree.ts
  - src/application/commands/internal/fsck/special-blobs.ts
---
# 1148 — fsck's HFS alias fold walks raw bytes with git's UTF-8 reader

- **Status:** accepted
- **Date:** 2026-11-06
- **Design:** docs/design/fsck-raw-byte-dotgit-alias.md · **Supersedes/Refines:** refines ADR-763, ADR-978

## Context

git's `is_hfs_dot_generic` reads a tree entry name through `next_hfs_char`, which returns 0
on any sequence `pick_one_utf8_char` rejects. After a complete needle (`.git`, `.gitmodules`,
`.gitattributes`, `.gitignore`, `.mailmap`) the final check is `if (c && !is_dir_sep(c))
return 0`, so a rejected sequence or a `/` ends the name and the name matches. Pinned twice on
2.56.0: `.git` + FF, `.GIT` + FF, U+FFFE/U+FFFF, surrogates, overlongs, a lead above F4 and
`.gitmodules/x` all report; a rejection inside the needle, `.gitx` + FF and a valid character
after the needle do not. tsgit's `foldsToHfsAlias` decoded the span with a `TextDecoder`, so a
rejected byte became U+FFFD and failed the exact-length match, and it required end-of-span, so
`.gitmodules/x` failed too. Every fsck alias comparison routes through this one predicate.

## Options considered

1. **A byte-level port of `next_hfs_char` and `is_hfs_dot_generic` on git's picker, no
   decoder** — pros: mirrors git line for line, allocates no decoded string, exits after the
   first sequence for nearly every name, removes the module's last decoder / cons: a private
   three-byte code-point computation for the ignorable set. The designer's recommendation.
2. **Truncate the span at the picker's valid prefix and keep the decoder fold over it, plus
   the `/` rule** — pros: smaller diff / cons: scans the name twice and allocates a string per
   call, up to seven calls per entry.
3. **Keep the decoder and treat U+FFFD as end-of-name** — cons: refuted by pinned rows: a
   literal EF BF BD must not match, and U+FFFE/U+FFFF decode to real characters and would
   still not match.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-763 (the fold is one byte-level
function in the shared entry-bytes module), ADR-751 (no text decoder on byte keys) and
ADR-978 (the HFS check stops where git's picker rejects): option 1.** The HFS arm of
`matchesDotgitAlias` walks `buf[start, end)` directly: HFS-ignorable code points are skipped
only when the picker accepts their three-byte sequence; each needle character is compared on
its raw byte, ASCII-folded; after the needle the name matches when the span ends, when the
picker rejects the next sequence, or when the next byte is `/`. No look-ahead crosses `end`.
The NTFS arm, the duplicate key, the sort key and the length count are unchanged.

## Consequences

- Every pinned row holds on tsgit: `hasDotgit` on the rejected-tail family, `gitmodulesSymlink`
  (error, exit 1) on a `.gitmodules` + rejected-byte or `.gitmodules/x` symlink, the
  `.gitattributes`/`.gitignore`/`.mailmap` symlink notices, and the blob routed into the
  gitmodules and gitattributes content checks. Severities are unchanged.
- The `/`-tail rule is part of the same line of git and is folded here, not filed.
- The unit pin that expected `.git` + FF not to match is re-pinned to git's verdict.
- The HFS fold shares git's picker with the index-path check (ADR-1149), so the two sides
  cannot drift again.
