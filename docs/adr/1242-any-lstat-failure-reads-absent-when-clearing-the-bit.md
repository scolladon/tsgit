---
subjects:
  - src/application/primitives/internal/fs-probes.ts
  - src/application/primitives/internal/clear-skip-worktree-from-present-files.ts
---
# 1242 — Any lstat failure reads absent when clearing the bit

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/design/skip-worktree-present-files.md (D-G) · **Supersedes/Refines:** applies ADR-226

## Context

git's `path_found` treats every `lstat` failure as absent; an unsearchable directory clears
nothing and the command proceeds (X1, EACCES pinned). tsgit's probes reject errors other than
not-found and not-a-directory.

## Options considered

1. **Every errno means absent** (recommended), through one probe helper that documents why.
2. Not-found and not-a-directory absent, others rejected — `status` throws where git reads past.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — ADR-226, no trade-off: git never refuses
here.

## Consequences

### Negative

- A port error other than not-found is read as absence on this one path.
