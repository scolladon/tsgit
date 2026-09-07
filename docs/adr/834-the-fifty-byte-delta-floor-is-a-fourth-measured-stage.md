---
subjects:
  - src/application/primitives/internal/deltify.ts
---
# 834 — The 50-byte delta floor is a fourth measured stage

- **Status:** accepted
- **Date:** 2026-09-07
- **Design:** docs/design/name-hash-delta-ordering.md (DC-9) · **Supersedes/Refines:** extends ADR-831

## Context

`should_attempt_deltas` never offers an object under 50 bytes as a delta target or as a base.
tsgit offers every object. Pinned empirically against git 2.55.0 in throwaway repositories, not
inferred from source.

It moves structure on every corpus. `DELTA_CHAIN_FIXTURE`'s 300 root trees are 40 bytes, so git
writes 300 tree bases where tsgit writes tree deltas. Any structural comparison against git —
and the structural readout is the oracle this work relies on, since git's pointer tiebreak puts
byte-identity out of reach — carries that 300-object discrepancy until the floor lands.

It also interacts with the search bound's unsigned underflow (ADR-835): under sha1 the floor
excludes every object small enough to underflow, so the floor hides the wrap entirely on sha1
repositories. Under sha256 it does not, because objects of 50 to 63 bytes are above the floor
and still underflow.

## Options considered

1. **A fourth measured stage in this change** (chosen) — pros: a known, cheap, byte-moving divergence landed with its own attribution, by the same reasoning that put the bound and promotion in scope; it is what makes the structural readouts comparable, since without it every tree-line comparison against git carries a known discrepancy / cons: a fifth measurement point, and a few KiB given back on each fixture.
2. **A named residual with its own backlog entry** — pros: a smaller change / cons: every structural comparison against git stays contaminated by a discrepancy that must be explained on each reading.
3. **Folded into the bound stage as another size filter** — cons: merges two byte-moving changes into one measurement, which is exactly what the staging discipline exists to prevent.

## Decision

**User-ratified.** `DELTA_FLOOR_BYTES = 50`. Objects below it are emitted as bases and are never
admitted to the window, as neither target nor base. It lands as its own commit with its own
measurement row, after the promotion stage.

## Consequences

The structural oracle becomes clean: a `git verify-pack -v` tree-line comparison against git no
longer carries a systematic 300-object offset on the deep-chain fixture, so a future reading of
those numbers means what it appears to mean.

The packs grow slightly — roughly 300 times the difference between a deflated 40-byte tree and a
deflated tree delta on the deep-chain fixture, a few KiB. This is the second place in this change
where faithfulness is bought with bytes, and like the bound it is recorded rather than absorbed.

Delta selection gets cheaper: objects under the floor are skipped before any window work, which
removes encode attempts that could never have been kept.

The stage count reaches four, and the published figure is the last row that lands. Any comparison
against a number from this work must name which stage it is comparing, or it compares nothing.
