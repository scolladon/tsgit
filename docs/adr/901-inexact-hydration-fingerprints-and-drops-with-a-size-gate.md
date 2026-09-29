---
subjects:
  - src/application/primitives/detect-similarity-renames.ts
---
# 901 — Inexact hydration fingerprints and drops each blob, size-gated on large pools

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/rename-detection-git-parity.md (§3.1, §4.2, D3) · **Supersedes/Refines:** none

## Context

`detectSimilarityRenames` inflated every candidate blob and kept all bytes resident before
the size prefilter ran: 300 distinct 1 MB deletes and one 6-byte add cost 1.03 s / ~780 MB,
against 0.01 s / 8.4 MB for git, which checks sizes first and frees each blob after
fingerprinting. Reachable from `diff`, `blame` and merge on a hostile repository.

## Options considered

1. Size pass always + fingerprint-and-drop.
2. **Fingerprint-and-drop always + size pass only above a unique-regular-id threshold** —
   *recommended by the design.*
3. Fingerprint-and-drop only.

## Decision

**Option 2 — adopted-as-recommended (no user judgment).** Aligns with the hot-path-first
preference: residency is bounded in every case, and the +0.3–0.55 ms small-diff cost of an
unconditional size pass stays off the common path. The hostile case drops to ~36 ms.

## Consequences

- Memory residency is bounded by fingerprints, not blob bytes.
- A pool of many large, size-compatible blobs still holds blob-proportional fingerprint
  maps; a typed-array fingerprint is a separate change.
