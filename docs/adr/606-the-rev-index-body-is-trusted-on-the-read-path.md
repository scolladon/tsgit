# 606 — The reverse-index body is trusted on the read path

- **Status:** accepted (ratified — deviates from the design's recommendation)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (DC-4, T-6) · **Refines:** ADR-604, ADR-226

## Context

ADR-604 makes `buildOffsetTable` consume the `.rev` body, which feeds
`nextOffsetForEntry` and therefore decides packed-entry slice bounds. A wrong body yields
wrong bounds: inflate fails, or worse, succeeds on a truncated stream. git's own posture
is to trust — a `.rev` with an out-of-range body reads fine under git and only `fsck`
notices (design Pin H R14, re-verified this run). The design recommended verifying the
artefact's digest once per pack before first use, diverging from git only by declining to
use a file git would use.

## Options considered

1. **Trust, exactly like git** — byte-faithful, zero added cost / adopts git's exposure to
   a hostile body on a path where sorting is already correct.
2. **Verify the digest once per pack, then trust** (designer's recommendation) — one hash
   of a file ~1/6 the `.idx`'s size / a deliberate divergence, and a hash on a path the
   change exists to speed up.
3. **Verify the body against the sorted `.idx`** — self-defeating: computing the expected
   body *is* the sort the `.rev` exists to avoid.

## Decision

Option 1. The `.rev` body is used as found, with no pre-use digest verification, exactly
as git does. Verification lives where git puts it — in `fsck` (ADR-607, ADR-608).

The prime directive (ADR-226) is the ratio: tsgit replicates git's observable behaviour
including its trust posture, and a repository whose `.rev` an attacker can rewrite is a
repository whose `.pack` and `.idx` that attacker can rewrite too. The threat model's T-6
is therefore **accepted, not mitigated**, on the explicit grounds that it is git's own
exposure and confers no capability an attacker with repository write access lacks.

## Consequences

A security review will flag the trusted read of an attacker-influenceable file; this ADR
is the standing answer and the finding should be closed against it rather than re-argued.
Parse-time bounds still apply in full (ADR-611): trusting the body's *values* is not
trusting the file's *length*, and no `DataView` read may occur at an unproven offset.
Symmetric with ADR-615 for bitmaps.
