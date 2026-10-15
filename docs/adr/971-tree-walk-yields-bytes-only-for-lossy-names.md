---
subjects:
  - src/application/primitives/walk-tree.ts
---
# 971 — The tree walk yields path bytes only for lossy names

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** —

## Context

Tree → index routes (`buildIndexFromTree`, `materializeTree`) need the raw bytes of a lossy name.
They walk whole trees on the `reset` and checkout hot paths.

## Options considered

1. **A lossy-only byte channel on `walkTree`** — bytes yielded only when the entry's name or an
   ancestor's does not round-trip (recommended).
2. **The existing `pathBytes: true`** — one fresh array per yielded entry.
3. **A second walk** for bytes when the first saw U+FFFD.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Hot-path cost stays one U+FFFD scan per
name; bytes are materialised only below a lossy frame.

## Consequences

- No allocation per entry for UTF-8 trees.
- `walkTree` gains one internal option.
