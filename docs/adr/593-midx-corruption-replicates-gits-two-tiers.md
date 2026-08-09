# 593 — Midx corruption replicates git's two tiers

- **Status:** accepted (user-ratified, against the designer's recommendation)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-2, Pin G) · **Refines:** ADR-575's
  scope — the per-pack degradation posture stops one layer below the midx

## Context

Pin G shows git splits midx faults into two tiers. Tier A — bad signature, bad
version, missing required chunk, non-monotonic fanout, malformed/unordered `PNAM`,
out-of-range `pack-int-id` — calls `die()`: every read in the process fails, loose
objects included. Tier B — file too small, unreadable, chunk offsets out of
bounds/order, final-chunk-id mismatch, hash-version disagreement — is `error()`-and-
discard: the midx is ignored and reads are served from the `.idx` scan. The designer
recommended diverging: uniform Tier B, on ADR-575's "a corrupt artefact must not deny
every object" principle.

## Options considered

1. **Replicate both tiers** — Tier A throws (every read fails, matching git's denial);
   Tier B warns and discards. Byte-faithful to Pin G's 17 rows.
2. **Uniform Tier B** (designer's recommendation) — always discard, never deny;
   available where git dies; an explicit recorded divergence.
3. **Uniform hard failure** — strictly worse than both.

## Decision

User-ratified **against** the recommendation: **replicate both tiers** (option 1).
Faithfulness (ADR-226) outranks the availability argument: a repo whose midx is
Tier-A-corrupt reads as broken under canonical git, and tsgit answering where git dies
is a divergence in refusal conditions — precisely what the prime directive forbids
without a ratified reason. ADR-575's posture governed per-pack artefacts whose
degradation git itself performs per-pack; git does not degrade a Tier-A midx, so
neither does tsgit.

## Consequences

`midx-source` maps the closed `MidxCheck` union to tiers exactly as pinned: Tier A
propagates as a thrown `TsgitError` that fails the read (loose objects included);
Tier B records a fault, warns once per generation, and falls back per Pin J. A
Tier-A chain layer dies even though a missing layer merely drops the chain (Pin I3).
The two rows first classified by analogy were both pinned during the design
revision's fsck matrix, and the analogy held for only one of them: an out-of-range
`LOFF` reference is confirmed Tier A, while a non-zero `numBaseFiles` byte is
**ignored outright** by git at every value probed — the midx still loads, is used,
and stays authoritative. Per this ADR's own ratio (replicate what git does, tier by
tier), `base-files` is therefore accepted-and-ignored rather than refused, and it is
not a `MidxCheck` member. T-6's total denial vector is accepted deliberately as
git's own property.
