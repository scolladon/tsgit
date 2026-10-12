---
subjects:
  - src/application/primitives/object-store.ts
---
# 924 — The alternate chain resolves lazily, once per session

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-12) · **Supersedes/Refines:** none

## Context

The chain must cost nothing per object for repositories without an alternates file. git prepares
alternates on first object access and re-reads the file only in `odb_reprepare`, add-only; its
miss retry re-scans packs but never the file.

## Options considered

1. **Lazily on first object-store access, memoised per session; `refresh()` re-reads add-only** (recommended).
2. **Eagerly in `openRepository`** — cons: object-free callers pay it.
3. **Re-read on every miss retry** — cons: not git.

## Decision

**User-ratified — option 1.** One `read` of `objects/info/alternates` per session, issued with
the primary registry's construction; a miss retry re-prepares every source's packs, never the file.

## Consequences

- Commands touching no objects pay nothing; a repository without alternates pays one `FILE_NOT_FOUND` read per session.
