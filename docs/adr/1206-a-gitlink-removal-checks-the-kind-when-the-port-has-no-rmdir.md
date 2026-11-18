---
subjects:
  - src/application/primitives/internal/empty-directories.ts
  - src/application/primitives/apply-changeset.ts
---
# 1206 — A gitlink removal checks the kind when the port has no rmdir

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/gitlink-rmdir-keeps-occupant.md · **Supersedes/Refines:** refines ADR-1205

## Context

`rmdir` is optional on the `FileSystem` port. A third-party adapter without it (or
`unsafeRawAdapters` over one) still reaches `removeEmptyDirectory`'s `rm` fallback, whose
documented precondition — the path is known to be a directory — `removeGitlinkDirectory` does not
check. The guard that checks it, `removeIfEmptyDirectory`, already exists in
`prune-emptied-directories.ts`.

## Options considered

1. **Route `removeGitlinkDirectory` through `removeIfEmptyDirectory`, moved to
   `empty-directories.ts`.**
2. **Leave it** — only adapters that omit an optional member stay exposed.

## Decision

**adopted-as-recommended (no user judgment)** — no trade-off: the guard exists and only moves;
without it the fix holds only for adapters that implement `rmdir`.

## Consequences

An `rmdir`-less adapter pays one `lstat` per removed gitlink and keeps the occupant like git.
