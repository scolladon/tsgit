---
subjects:
  - src/domain/diff/similarity.ts
  - src/application/primitives/detect-similarity-renames.ts
---
# 912 — Similarity fingerprints are typed arrays, built by packed sort or bucket array

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/diff-core-parity-hardening.md (item 3, H6, H7) · **Supersedes/Refines:** none

## Context

`Map`-based fingerprints made `-M -B` over 300 × 1 MiB modifies take ~45 s / 551 MB of
fingerprints (git ~11 s). git's `spanhash_top` is a sorted table scored by a merge scan.

## Options considered

1. **Hybrid: packed sort below 107 927 bytes, dense bucket array above** — *recommended by the
   design.*
2. Packed sort only (transient memory up to 4 × blob).
3. git's open-addressing table (~1.8× slower build).

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Per the user's size policy, this
commit must be bundle-size-neutral; if it cannot be, it escalates with the measured delta
(ADR-904's bump applies only to git-mandated growth).

## Consequences

- Scoring ~4× faster (prototype 12.1 s vs 46.4 s), fingerprint memory 551 → 82 MB, output
  identical to the corrected Map implementation (property oracle).
