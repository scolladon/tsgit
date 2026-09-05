---
subjects:
  - src/adapters/memory/memory-file-system.ts
  - src/ports/file-system.ts
---
# 811 — A file at an ancestor segment keeps the memory adapter's own report

- **Status:** accepted
- **Date:** 2026-09-05
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-B) · **Supersedes/Refines:** none

## Context

When a regular file occupies an ancestor segment of an exclusive-create target, the memory
adapter throws `NOT_A_DIRECTORY` carrying the ancestor's path, from `addDirectoryRecursive`. The
node adapter, probed as the composed adapter rather than the bare syscall, throws `FILE_EXISTS`
when the file is the immediate parent (its `mkdir -p` sees `EEXIST`) and `NOT_A_DIRECTORY` at any
deeper ancestor, always carrying the requested path. No test in the suite asserts `data.path` on
an adapter-produced `NOT_A_DIRECTORY`. Seven memory surfaces funnel through the same helper.

## Options considered

1. **Leave the memory adapter's code and reported path alone; document the divergence in the
   port comment and cover only depth two and beyond in the contract suite** (designer's
   recommendation) — pros: the only option that does not trade a real divergence for a cosmetic
   one / cons: the two adapters keep disagreeing at depth one.
2. **Throw `notADirectory(requestedPath)` from `addDirectoryRecursive`, aligning the path across
   the seven surfaces** — pros: cheap, nothing breaks / cons: fixes the field no caller reads
   while the depth-one code divergence stays.
3. **Mirror the node adapter exactly, depth-one `FILE_EXISTS` included** — cons: imports an
   artefact of `mkdir -p` into an adapter that has no `mkdir -p`.

## Decision

**Ratified by the user: option 1.** Node is not self-consistent here: the same fault at two
depths yields two codes because `mkdir -p` decides it, so there is no single behaviour to
converge on. The memory adapter keeps `NOT_A_DIRECTORY` with the ancestor path at every depth.
The port's `writeExclusive` comment records that a file at an ancestor segment refuses, with the
code adapter-dependent at depth one and `NOT_A_DIRECTORY` beyond it. The shared contract suite
asserts the depth-two case by code only. This is a decision that the behaviour is acceptable and
documented, not a deferral.

## Consequences

Callers must not branch on the `path` field of a `NOT_A_DIRECTORY` raised by a write surface, and
must accept either `FILE_EXISTS` or `NOT_A_DIRECTORY` for a file at the immediate parent. Any
future alignment reopens this record rather than the memory adapter alone.
