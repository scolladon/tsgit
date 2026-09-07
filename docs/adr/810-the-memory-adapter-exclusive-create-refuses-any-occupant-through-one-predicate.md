---
subjects:
  - src/adapters/memory/memory-file-system.ts
---
# 810 — The memory adapter's exclusive create refuses any occupant through one predicate

- **Status:** accepted
- **Date:** 2026-09-05
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-A) · **Supersedes/Refines:** none

## Context

`MemoryFileSystem.writeExclusive` refuses a file or a symlink at the target but not a directory:
the write succeeds and one key lands in both the `files` map and the `directories` set. The node
adapter's `O_EXCL` open and canonical git's lock protocol both refuse a directory with
`File exists`, pinned in the design's §1a–§1c. `symlink` in the same file already tests all three
namespaces before creating; `writeExclusive` is the second writer computing the same predicate
and the one that got it wrong. Three committed Stryker equivalence proofs in the file rest on the
three namespaces being pairwise disjoint, which the bug falsifies.

## Options considered

1. **Add `|| this.directories.has(normalized)` inline in `writeExclusive`, mirroring `symlink`** —
   pros: smallest diff / cons: leaves a second copy of the predicate free to drift again.
2. **Extract `private occupied(normalized): boolean` returning the three-way disjunction; both
   writers throw `fileExists(path)` on it** (designer's recommendation) — pros: one expression
   for one question, halves the guard's mutant population without suppressing anything / cons:
   one more private member.
3. **Extract `private assertUnoccupied(normalized, path): void` that throws** — cons: couples the
   predicate to one error code and leaves no boolean to test directly.

## Decision

**Adopted-as-recommended (no user judgment): option 2.** One private `occupied(normalized)`
predicate answers "is anything at this normalized path" over the three namespaces, and both
`writeExclusive` and `symlink` throw `fileExists(path)` when it is true. `exists` is **not**
folded in: it answers a different question (node's `exists` follows symlinks and reports a
dangling link as `false`, while an exclusive create refuses it), so sharing a helper would cement
a coincidence as intent. Each disjunct is proven by its own single-occupant test.

## Consequences

A directory occupant, a directory with children, and the adapter's own `rootDir` all refuse with
`FILE_EXISTS` carrying the requested path; the three disjointness proofs become unconditional.
The receive path's `writeOrKeepArtifact` reaches its `!occupant.isFile` arm on the memory adapter
without a test-side patch. The `exists` divergence on a dangling symlink stays as it is and is
named in the design's out-of-scope list.
