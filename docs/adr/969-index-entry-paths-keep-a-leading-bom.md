---
subjects:
  - src/domain/git-index/index-parser.ts
---
<!-- cspell:ignore BOM -->
# 969 — Index entry paths keep a leading BOM

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-226

## Context

The index parser decodes entry paths with the BOM-stripping `decode`, so a path starting with
U+FEFF loses it and is renamed on the next tsgit write. Pinned against git 2.55 (design §D1, rows
A1–A4, D1, D2): `ls-files` lists `﻿a/x` after `git add`, `a/x` after a tsgit `add z`.

## Options considered

1. **Decode with `decodePreservingBom`** — `path` keeps U+FEFF, the bytes round-trip, no
   `pathBytes` needed (recommended).
2. **Treat a BOM as lossy** like the cache-tree parse (`decode` + raw bytes).

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** A BOM path is valid UTF-8; keeping U+FEFF
in `path` matches the working tree, tree-entry names (already `decodePreservingBom`) and pathspecs.
`﻿.git/x` stays refused: the HFS-ignorable strip in path verification still sees `.git`.

## Consequences

- status, `rm --cached` and every index write address a BOM path as git does.
- Consumers comparing `entry.path` to a BOM-stripped string now get git's value.
