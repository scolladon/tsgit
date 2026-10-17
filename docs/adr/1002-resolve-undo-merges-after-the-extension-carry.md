---
subjects:
  - src/domain/git-index/carry-extensions.ts
  - src/application/primitives/internal/index-lock.ts
---
# 1002 — Resolve-undo merges after the extension carry

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** refines ADR-999

## Context

The index write carries extensions through `carriedExtensions`, which returns early when the previous
index has none. A resolve-undo record must still be written then. The design threaded a fifth `resolved`
parameter through `carryExtensions`, which edits a guarded line and about 24 test call sites.

## Options considered

1. A domain function `withResolveUndo` applied to the carry's result, leaving `carryExtensions` and its
   guard unchanged (recommended).
2. A fifth `resolved` parameter on `carryExtensions`.

## Decision

**Adopted-as-recommended (no user judgment)** — option 1: diff-minded, a pure domain function, and it
covers the extension-less previous index the early return skips.

## Consequences

- `CommitOptions` gains `resolveUndo`; `carryExtensions`' signature is unchanged.
