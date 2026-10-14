---
subjects:
  - src/application/commands/status.ts
  - src/application/primitives/internal/index-lock.ts
---
<!-- cspell:ignore ENOSPC -->
# 961 — Optional-lock and refresh-write failures degrade to a read-only status

- **Status:** accepted
- **Date:** 2026-10-14
- **Design:** docs/design/status-refresh-index-extensions.md · **Supersedes/Refines:** refines ADR-958

## Context

The 2026-09-10 ruling named three degrade cases: lock exists, `EROFS`, `EACCES`. git takes the optional
lock with flags `0` (no `LOCK_DIE_ON_ERROR`, no `LOCK_REPORT_ON_ERROR`), so every failure to create it
leaves `status` read-only, and `repo_update_index_if_able` ignores `write_locked_index`'s return value,
so every write failure is dropped too (pins P6, P7).

## Options considered

1. **The ruled set only** — `FILE_EXISTS`, `PERMISSION_DENIED`, `EROFS` degrade; `ENOSPC`, `EIO` and the
   rest propagate (the designer's recommendation).
2. **Any failure, logged** — git's surface: every acquisition or write failure degrades, and is reported
   through the context logger with its code and path.
3. **The ruled set plus browser OPFS mapping.**

## Decision

**User-ratified — option 2.** Any failure to take the optional lock, and any failure to write or rename
the refreshed index after it was taken, degrades `status` to its read-only result; the lock is released.
Nothing is swallowed: each degrade is reported through `ctx.logger?.warn` with the error code and the
path. A failure that is not about the optional lock or the refresh write — reading the index, the
report itself — propagates as before.

## Consequences

- `status` never fails because the index could not be written, on any adapter, including OPFS errors the
  browser adapter does not map yet.
- The degrade path is observable to embedding applications through the logger rather than through the result.
