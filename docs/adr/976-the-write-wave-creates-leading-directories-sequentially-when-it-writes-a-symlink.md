---
subjects:
  - src/application/primitives/apply-changeset.ts
---
# 976 — The write wave creates leading directories sequentially when it writes a symlink

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-974

## Context

ADR-974 forbids a working-tree write through a leading symlink. Only a symlink written in the same wave can race a pooled write's leading-path scan (design §D18).

## Options considered

1. **Run a sequential leading-directory phase only when the changeset writes a symlink** (recommended).
2. Always run it.
3. Keep the pool and group writes by the filesystem's folded name.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Checkouts without symlinks keep today's pooled hot path.

## Consequences

- No fold-class reproduction is needed (APFS case/normalisation, NTFS).
- A wave that writes a symlink pays one sequential lstat/mkdir pass per distinct leading directory.
