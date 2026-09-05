---
subjects:
  - src/adapters/memory/memory-file-system.ts
---
# 815 — Non-exclusive write and rename refuse a directory occupant on the memory adapter

- **Status:** accepted
- **Date:** 2026-09-05
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-F) · **Supersedes/Refines:** none

## Context

The same defect family exists in the non-exclusive `write`: the memory adapter silently replaces
a directory with a file entry where the node adapter throws `PERMISSION_DENIED` from `EISDIR`.
`writeUtf8`, `writeStream` and `appendUtf8` all delegate to `write`, so one guard covers four
surfaces. `rename` is the remaining surface that can land a file entry on a directory name; its
destination-clobber and directory-rename semantics were not probed in the design.

## Options considered

1. **Out of scope; the brief names `writeExclusive` only** — pros: scope discipline / cons: the
   port's cross-adapter guarantee stays broken in the common case.
2. **Fix `write` in this change; the three delegating surfaces inherit** (designer's
   recommendation) — pros: one guard closes four surfaces / cons: scope growth, needs its own
   unit rows and a contract row.
3. **Option 2 plus `rename`** — pros: closes every surface that can put a file entry on a
   directory name in one change / cons: `rename` needs its own pinned matrix before anything is
   changed.

## Decision

**Ratified by the user: option 3, against the design's recommendation.** The memory adapter's
`write` throws `permissionDenied(path)` for a directory at the leaf, matching the node adapter's
`EISDIR` mapping, and `writeUtf8`, `writeStream` and `appendUtf8` inherit it. `rename` refuses
whatever the node adapter refuses when a directory occupies the destination or the source and
destination differ in kind. The exact `rename` codes are pinned by a node-versus-memory matrix in
the revised design before implementation, following the same composed-adapter probing the
exclusive-create matrix used; the memory adapter then matches those codes. No surface in the
memory adapter may land a file entry on a name held by a directory.

## Consequences

The design is revised against this record before planning: it gains the `rename` matrix, the
`write` and `rename` unit rows, one contract row per newly pinned refusal, and a derivation of the
browser adapter's `write` and `rename` behaviour on the same arrangements. Any memory-backed test
that today writes or renames over a directory path starts failing; the design's sweep found none,
and `npm run validate` is the arbiter.
