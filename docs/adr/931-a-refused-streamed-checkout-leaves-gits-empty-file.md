---
subjects:
  - src/application/primitives/internal/write-working-tree-file.ts
  - src/application/primitives/apply-changeset.ts
---
# 931 — A refused streamed checkout leaves git's empty file

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-19) · **Supersedes/Refines:** refines ADR-928, ADR-226

## Context

When git's streamed checkout of a regular file is refused (Pin M5, corrupt alternate midx), git
has already opened the output file, and `die` skips the unlink: an empty file is left in the
worktree. tsgit resolves the object before opening the output and leaves nothing.

## Options considered

1. **Keep tsgit's order, record the divergence** (designer recommendation).
2. **Reproduce git's on-disk state: open the output before streaming, leave it on refusal**.

## Decision

**User-ratified — option 2.** On-disk state after a refusal is part of git's observable
behaviour (ADR-226): the worktree file git would leave empty is left empty by tsgit, with the
same refusal surfaced.

## Consequences

- Interop pin M5 compares the worktree state after the refused checkout, not only the error.
