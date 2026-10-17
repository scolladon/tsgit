---
subjects:
  - src/application/primitives/apply-changeset.ts
  - src/application/commands/rm.ts
  - src/application/commands/add.ts
---
# 973 — Lossy index entries are never touched on disk

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-968, ADR-970

## Context

The filesystem port is string-pathed, so a lossy entry (raw `\xff.txt`) can only be reached on disk
through its decoded view (`�.txt`). Checkout writes it there; when the index also holds the
literal `�.txt`, one file silently wins. `rm` unlinks and `add --renormalize` stats that view,
which is another file. git on macOS cannot create the raw name (an illegal byte sequence) and the entry reads as
deleted; git on Linux writes the raw name.

## Options considered

1. **Never touch a lossy entry on disk** — never written, unlinked or stat'd; it is absent from the
   working tree for every reader (recommended).
2. **Refuse on collision only** — keep writing under the decoded view, refuse when two targets map to
   one on-disk name.
3. **Leave as is** and backlog a byte-path filesystem port.

## Decision

**User-ratified — option 1.** A lossy entry has no working-tree file tsgit can name. Checkout and
reset skip its write, `rm` skips its unlink, every stat/compare treats it as absent, and no route
reads the decoded-view file as its content.

## Consequences

- No route can overwrite, delete or hash a different file through a lossy entry's view.
- The outcome matches git on macOS (the entry reads as deleted), without git's error line.
- On Linux git materialises the raw name; tsgit cannot until the filesystem port takes bytes.
