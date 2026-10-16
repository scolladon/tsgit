---
subjects:
  - src/ports/file-system.ts
  - src/application/primitives/internal/prune-emptied-directories.ts
---
# 989 — The filesystem port removes an empty directory in one call

- **Status:** accepted
- **Date:** 2026-10-16
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** —

## Context

git removes every directory a checkout, reset, merge or `rm` leaves empty, climbing until an `rmdir`
fails. A tracked entry the operation leaves alone may already be gone from disk, so its directory can
be empty too: only an attempt tells. Through the port's `rm` ("file or empty directory") an attempt on
a non-empty directory costs a realpath, an `rm` that fails with EISDIR, an `rmdir` and a caught error:
a checkout deleting one file in each of 2,000 directories pays +195 ms for the faithful attempts.

## Options considered

1. **A directory-only removal on the port**, one call, failing fast on a non-empty directory
   (recommended).
2. Accept the cost.
3. Keep skipping directories that still track an entry, leaving empty directories behind where git
   removes them.

## Decision

**User-ratified — option 1.** The `FileSystem` port gains a removal for an empty directory; every
adapter implements it with its platform's single directory removal. Pruning uses it and attempts
every emptied candidate, as git does.

## Consequences

- Pruning is git-faithful without a per-directory probe chain.
- Custom `FileSystem` implementations gain one method to provide (or a documented fallback).
