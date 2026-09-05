---
subjects:
  - src/adapters/memory/memory-file-system.ts
---
# 817 — Renaming a directory into itself refuses before the destination-kind check, as linux does

- **Status:** accepted
- **Date:** 2026-09-05
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-H) · **Supersedes/Refines:** refines ADR-815

## Context

ADR-815's text does not reach a `rename` whose destination lies inside its own directory source,
nor a `rename` of the containment root to a name inside it. The node adapter throws
`UNSUPPORTED_OPERATION` with the invalid-argument errno as its reason and no path field for every
such arrangement, except when the destination already exists as a file or symlink: there darwin
reports `NOT_A_DIRECTORY` and linux reports `UNSUPPORTED_OPERATION`, the one platform-divergent
row in the pinned matrix. The memory adapter today re-parents the subtree under its own
descendant, leaving `lstat` of the source failing while `readdir` of its child works, and a rename
of the root silently relocates the whole repository one level deeper.

## Options considered

1. **One clause before the file-or-symlink destination check, throwing `UNSUPPORTED_OPERATION`
   with the invalid-argument errno as reason for every inside-source arrangement** (designer's
   recommendation) — pros: matches linux exactly, and linux gates every merge / cons: diverges from
   darwin when the destination is an existing file or symlink; the error carries no path.
2. **The same clause after the file-or-symlink check** — pros: matches darwin exactly / cons:
   diverges from linux on the same arrangement.
3. **Out of scope** — cons: leaves the only arrangements that produce a structurally incoherent
   tree, one of them reachable from a one-argument mistake with no error at all.

## Decision

**Ratified by the user: option 1.** The `rename` precondition refuses a destination inside the
directory source, including a rename of the root into itself, before it inspects the
destination's kind, with the same error data the node adapter produces on linux: code
`UNSUPPORTED_OPERATION`, the node adapter's `filesystem` operation label and the invalid-argument
errno name as the reason. Node itself is not self-consistent across platforms here, so one
behaviour is chosen and recorded, the way ADR-811 resolved the ancestor case. That arrangement is
never a strict cross-adapter contract row; it is pinned memory-side.

## Consequences

The memory adapter can no longer nest a directory under itself or relocate its root. Borrowing an
errno name into an adapter that has no errnos is a cost taken knowingly; the name is a string the
node adapter already emits. The errno name enters the spelling dictionary at its alphabetical
position.
