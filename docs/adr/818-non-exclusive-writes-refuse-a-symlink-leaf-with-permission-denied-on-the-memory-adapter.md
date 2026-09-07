---
subjects:
  - src/adapters/memory/memory-file-system.ts
---
# 818 — Non-exclusive writes refuse a symlink leaf with PERMISSION_DENIED on the memory adapter

- **Status:** accepted
- **Date:** 2026-09-05
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-I) · **Supersedes/Refines:** refines ADR-815

## Context

The node adapter opens every non-exclusive write with `O_NOFOLLOW`, so a symlink at the leaf
fails with `ELOOP`, which `mapErrno` reports as `PERMISSION_DENIED`, the same code it gives a
directory occupant. The memory adapter today writes a `files` key beside the surviving
`symlinks` key: `lstat` says symlink, `readlink` returns the old target and `read` returns the
new bytes. ADR-815 names a directory occupant only. The guard ADR-815 adds to `write` is the
natural place for the second term, and `openWithNoFollow` in the same file already refuses a
symlink leaf with exactly this code. The design's sweep found no call site writing onto a symlink
across the whole suite.

## Options considered

1. **Extend the `write` guard by one term so a directory or a symlink at the leaf throws
   `permissionDenied(path)`** (designer's recommendation) — pros: one code covers both occupants
   as on node, and the last open pair of the disjointness invariant closes in the same change /
   cons: scope beyond ADR-815's wording.
2. **Out of scope** — cons: the invariant stays two-thirds closed and the remaining route is only
   documented.
3. **Refuse in `write`, `writeStream` and `writeUtf8` but not `appendUtf8`** — cons: incoherent,
   since `appendUtf8` delegates to `write`.

## Decision

**Ratified by the user: option 1.** `write` refuses when the normalized leaf is in `directories`
or in `symlinks`, throwing `permissionDenied(path)`; `writeUtf8`, `writeStream` and `appendUtf8`
inherit it. Each term is proven by its own single-occupant test. The `files`, `directories` and
`symlinks` key sets are pairwise disjoint under every reachable adapter call once this and
ADR-815 land.

## Consequences

Writing through a symlink is refused on both first-party adapters. A caller that wants to replace
a link must remove it first, as on node.
