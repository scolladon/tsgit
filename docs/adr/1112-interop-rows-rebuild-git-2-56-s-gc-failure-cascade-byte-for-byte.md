---
subjects:
  - test/integration/maintenance-interop.test.ts
  - test/integration/alternates-gc-fsck-interop.test.ts
---
# 1112 — interop rows rebuild git 2.56's gc failure cascade byte-for-byte

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (F5, D-F5b) · **Supersedes/Refines:** refines ADR-226 and ADR-249

## Context

When git 2.56's pack step fails, `odb/source-files.c` reports `error: failed to run %s` with an
argv the preceding `run_command()` already cleared, so the line reads
`error: failed to run (null)` on glibc and on macOS C library alike; 2.55.0 printed
`fatal: failed to run repack`. A `gc` whose `core.deltaBaseCacheLimit` is malformed now prints the
fatal line, `error: failed to run pack-refs`, the fatal line again and `fatal: failed to run
worktree`, where 2.55.0 printed the fatal line once. Exit statuses are unchanged. tsgit emits no
text, so only the interop reconstruction is affected.

## Options considered

1. **Rebuild the literal bytes, `(null)` and the cascade included** — pros: faithful to what the
   pinned git prints; costs nothing in the library / cons: the row encodes a git bug and a
   C library-specific rendering.
2. **Compare only the leading fatal lines tsgit's data names, ignoring the tail** — pros: robust
   to a later git fix / cons: a weaker pin that no longer proves the full stream.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The maintenance and alternates gc rows
rebuild git 2.56.0's complete stderr, `(null)` and the pack-refs/worktree cascade included. The
rendering is identical on the Linux and macOS lanes these rows run on, and the rows do not run on
the Windows lane.

## Consequences

- When a later git fixes the cleared argv, the CI git pin flags the drift and the rows are
  re-pinned under a new version, not loosened now.
