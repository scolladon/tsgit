---
subjects:
  - src/domain/eol/ident.ts
  - src/domain/eol/ident-transform.ts
  - src/application/primitives/internal/write-working-tree-file.ts
  - src/application/primitives/apply-changeset.ts
  - src/application/commands/archive.ts
---
# 955 — `ident` ships in this run with both of git's expanders

- **Status:** accepted
- **Date:** 2026-10-12
- **Design:** docs/design/eol-conversion.md · **Supersedes/Refines:** refines ADR-226

## Context

The `ident` attribute collapses `$Id: … $` to `$Id$` on the way into the repository and expands
`$Id$` to `$Id: <blob id> $` at the repository's hash width (40 or 64 hex) on the way out (§D1.9 of
the design). Today tsgit stores an `ident` path's `$Id: … $` verbatim, so its blob id is already
wrong. git has two expanders that disagree on edge inputs: the streamed `ident_filter` (used
wherever a checkout streams: `ident`, `text`, `eol=*`, `-text` classes) treats the `$` of `$$` as
consumed and keeps `$Id: a\tb $`; the in-core `ident_to_worktree` (the `auto` / `auto-crlf` class,
archive, in-core merge writes) expands `$$Id$` and keeps `$Id:a b$`. Both are pinned.

## Options considered

1. **In scope: collapse, both expanders, sha1 and sha256** (recommended). Pros: blob ids and
   worktrees match git; the scanners are small pure functions with property tests and the stream
   transform slot exists for LF→CRLF anyway. Cons: two expanders to maintain.
2. **Collapse only** — pros: blob ids right; cons: worktrees stay unexpanded and `status` disagrees
   with git after checkout.
3. **Refuse with `UNSUPPORTED_OPERATION` when `ident` engages** — leaves the wrong-blob-id gap.

## Decision

**User-ratified — option 1.** `identToGit` collapses on every to-git route. Expansion follows
the route's class: the streamed expander (`createIdentTransform`) wherever git streams the
checkout, the in-core expander (`identToWorkingTree`) wherever git converts in core (the
`auto` / `auto-crlf` class, archive, merge-family in-core writes). The documented disagreement
between the two is reproduced route by route, never unified. The expansion width is the
repository's hash algorithm; the expanded id is the index entry's blob id (the pre-CRLF bytes).

## Consequences

- A foreign `$Id: … $` with an inner space is kept on checkout and collapsed on add, so the file
  reads modified — git's own asymmetry, pinned and kept.
- Property tests prove each expander's round trip and chunk-independence; the divergence blob is
  pinned by examples on checkout and on archive.
- An upstream unification of the two expanders would be a new decision, not a silent change.
