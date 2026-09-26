---
subjects:
  - src/application/primitives/read-object.ts
  - src/application/primitives/internal/blob-source.ts
  - src/application/commands/fsck.ts
supersedes:
  - adr: "863"
    scope: "whole-object reads of a size-lying loose blob serve its real bytes"
---
# 907 — Whole-object loose reads bound the inflate to the size claim, like git

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/diff-core-parity-hardening.md (item 1, H1) · **Supersedes:** ADR-863 (whole-object blob reads only)

## Context

A loose blob whose header claims 6 bytes but inflates to 200 MB passed the declared-size gate
and was inflated in full (20 such blobs: ~8.4 s / ~580 MB). git's whole-object read
(`unpack_loose_rest`) inflates at most header + claim and refuses an overrun, while its
streaming routes (`cat-file` content, `show` of a blob, checkout) serve the real bytes.
ADR-863 served the real bytes on every route.

## Options considered

1. **git's tiers** — whole-object reads bound to the claim (refuse an overrun past git's
   32-byte header window, truncate inside it); streaming routes keep real bytes; a short body
   keeps ADR-863's residual. *Recommended by the design.*
2. Refuse every overrun on every route.
3. Bound rename/break hydration only.

## Decision

**Option 1 — ratified by the user.** `fsck` reports a size-lying blob as git does.

Superseded from ADR-863: whole-object reads of a size-lying loose blob serving its real bytes.
Carried forward from ADR-863: streaming routes serving real bytes; commit/tree/tag refusal;
the short-body residual; ADR-854's cache value shape.

## Consequences

- The hostile rename case drops to git's order of magnitude.
