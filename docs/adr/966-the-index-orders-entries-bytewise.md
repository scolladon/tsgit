---
subjects:
  - src/domain/git-index/index-writer.ts
---
<!-- cspell:ignore bytewise DFFF -->
# 966 — The index orders entries bytewise

- **Status:** accepted
- **Date:** 2026-10-14
- **Design:** docs/design/status-refresh-index-extensions.md · **Supersedes/Refines:** refines ADR-226

## Context

`compareEntryPath` orders entries by UTF-16 code unit; git orders them by UTF-8 byte. The two agree
except when a surrogate (`D800–DFFF`) meets a unit in `E000–FFFF`: tsgit writes `😀.txt` before the
U+FFFD-named file, git the reverse. Pinned against git 2.55: such an index makes `git fsck` exit 128
(`unordered stage entries in index`), and `git add -A` on it duplicates the entry.

## Options considered

1. **Fix in this run** — an allocation-free, surrogate-aware comparator used by the writer and the
   three pre-sorts that feed it, pinned by a non-BMP vs U+FFFD interop twin (recommended).
2. **A separate backlog entry.**

## Decision

**User-ratified — option 1.** Entries are ordered by UTF-8 byte order of their paths, then by stage.
The comparator compares code units and, at the first difference, maps units at or above `0xD800` so
surrogates sort after `E000–FFFF` — O(1) per comparison, no allocation. Every sort that feeds the
index writer uses it.

## Consequences

- A tsgit-written index with non-BMP names next to `E000–FFFF` names passes `git fsck`.
- An index written by an older tsgit in UTF-16 order is re-sorted on the next write.
