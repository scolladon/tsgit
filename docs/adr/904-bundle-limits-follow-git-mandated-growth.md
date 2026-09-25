---
subjects:
  - .size-limit.json
---
# 904 — Size limits rise to the measured size when git-mandated behaviour crosses them

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/rename-detection-git-parity.md (§8, D7) · **Supersedes/Refines:** none

## Context

The rename-parity work adds an estimated 0.6–1.2 kB gzip; the browser bundle had ~50 B of
headroom under its ratcheted limit.

## Options considered

1. **Raise each crossed limit to measured + 0.25 kB in the commit that crosses it** —
   *recommended by the design.*
2. Trim unrelated code in this change.
3. Move the rename machinery into a separately loaded chunk.

## Decision

**Option 1 — ratified by the user.** The growth pays for git-faithful behaviour; the commit
that crosses a limit states the measured size.

## Consequences

- The ratchet keeps ~0.25 kB of headroom after this change.
