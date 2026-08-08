# 601 — fsck reports midx findings

- **Status:** accepted (user-ratified, against the designer's recommendation)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-10) · **Refines:** the fsck pack
  pass shipped for pack accessibility (28.1a's family, ADRs 581–591)

## Context

git's `fsck` reports midx problems the read path stays silent on: an incorrect
trailer checksum (exit 32), `failed to load pack in position N` for an unresolvable
`PNAM` entry, and `multi-pack-index file exists, but failed to parse` for an
unreadable file. The designer recommended deferring — a midx-reporting arm needs its
own pin matrix and roughly doubles the change's surface, the same reasoning that made
pack-accessibility reporting its own item (28.1a).

## Options considered

1. **Defer to a follow-up item** — document the residual fsck divergence; this PR
   stays midx-read-only.
2. **Ship fsck midx findings now** — full faithfulness in one PR; requires pinning
   git's fsck midx findings (messages, exit bits) as their own matrix.
3. **Cheap subset now** — report only "midx unusable" from already-loaded state.

## Decision

User-ratified **against** the recommendation: **ship fsck midx findings now**
(option 2). The work rides in this PR rather than becoming a residual gap; the
design must be revised with a dedicated fsck pin matrix (per-row message, exit code,
and finding shape) before planning.

## Consequences

The design revision adds an fsck-midx pin matrix and an fsck integration section:
the fsck pack pass gains midx findings mirroring git's, including trailer
verification at fsck time (see ADR-602 — the read path still never checks it). The
interop suite gains fsck rows asserting finding parity and exit-code parity against
real git.
