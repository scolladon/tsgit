---
subjects:
  - src/ports/file-system.ts
---
# 813 — The port's exclusive-create comment names every occupant shape

- **Status:** accepted
- **Date:** 2026-09-05
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-D) · **Supersedes/Refines:** none

## Context

The `writeExclusive` comment on the `FileSystem` port reads "Fails with `FILE_EXISTS` if the file
already exists (exclusive create)". The memory adapter implemented exactly that narrow reading,
and `docs/design/ports-and-adapters.md` wrote the narrow reading down as the memory adapter's
specification. The obligations beneath the sentence cover parent creation and the symlinked
ancestor escape but never say what counts as an occupant.

## Options considered

1. **Rewrite the summary to say `FILE_EXISTS` is raised when anything already occupies `path`, a
   regular file, a directory, or a symbolic link including a dangling one, and add one obligation
   line saying a file at an ancestor segment refuses, with the code adapter-dependent at depth
   one** (designer's recommendation) — pros: fixes the proximate cause and records the surviving
   divergence.
2. **Tighten only the occupancy sentence** — cons: hides the depth-one divergence.
3. **Leave the wording** — cons: the next adapter is free to repeat the mistake.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The comment states the occupancy rule
in terms of anything at `path` and carries the ancestor obligation with its adapter-dependent
depth-one code. The design-doc line that codified the narrow reading is corrected in the same
change.

## Consequences

The port text is the oracle for every adapter's exclusive create. Documenting the depth-one
divergence is what makes ADR-811 a recorded decision instead of an omission.
