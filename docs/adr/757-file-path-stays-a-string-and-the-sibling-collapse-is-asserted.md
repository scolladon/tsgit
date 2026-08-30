---
subjects:
  - src/application/primitives/internal/flatten-raw.ts
  - src/application/primitives/build-index-from-tree.ts
---
# 757 — FilePath stays a string and the sibling collapse is asserted

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (D10) · **Supersedes/Refines:** none

## Context

ADR-749 makes a tree entry's name byte-faithful, but the moment a name becomes a path it
becomes a `FilePath` — a decoded string. Two sibling entries whose names differ only in
invalid UTF-8 therefore map to one key in a flattened tree or an index, and one
overwrites the other. Measured, git 2.55.0: `read-tree` makes two distinct index
entries for such a pair, so this is a real divergence at the path layer. On macOS/APFS
`git checkout-index` itself then fails on the name with `Illegal byte sequence`, so the
divergence is only observable end-to-end on a filesystem that permits the bytes.

## Options considered

1. **Accept the limit at the path layer; record and assert it** — pros: honest, bounded, and the assertion fails the day someone claims otherwise / cons: a knowing divergence remains.
2. **Re-type the path currency to a byte-backed key** — cons: `FilePath` keys the index, status, diff, checkout, pathspec, gitignore and sparse-checkout; this is a repo-wide re-typing an order of magnitude larger than this work, and it would have to answer what a non-UTF-8 path means to the working-tree adapters.
3. **Refuse a name that does not survive a UTF-8 round trip** — cons: invents a refusal git does not have and makes the flatten path *less* faithful than it is today.

## Decision

**Adopted as recommended (no user judgment) — consistent with ADR-749's stated boundary.**
`FilePath` remains a decoded string. Byte fidelity is guaranteed at the tree-object
layer and ends at the path boundary; the collapse is asserted at the flattened-tree
level rather than by comparing worktree contents, so the assertion does not depend on
the host filesystem accepting the bytes.

## Consequences

The limit is stated at its real edge and covered by a test, rather than left to be
discovered. Anyone widening the path currency later has this ADR as the statement of
what that would buy.
