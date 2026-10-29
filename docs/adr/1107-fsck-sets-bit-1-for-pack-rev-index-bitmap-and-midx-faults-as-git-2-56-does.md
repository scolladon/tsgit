---
subjects:
  - src/application/commands/fsck.ts
  - src/application/commands/internal/fsck
  - docs/use/commands/fsck.md
supersedes:
  - adr: "586"
    scope: "exit bit 64 as a distinct value and its evaluation in every mode"
---
# 1107 — fsck sets bit 1 for pack, rev-index, bitmap and midx faults, as git 2.56 does

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (F1, D-F1a) · **Supersedes/Refines:** supersedes ADR-586 (bit 64 and its ungated evaluation); refines ADR-226

## Context

git 2.56 moved pack, reverse-index, bitmap and multi-pack-index verification out of `builtin/fsck.c`
into the object-source layer (a51b77a and its five follow-ups). `odb_fsck()` reports one failure
and `cmd_fsck` folds it into `ERROR_OBJECT`, so `ERROR_PACK` (4), `ERROR_MULTI_PACK_INDEX` (32),
`ERROR_PACK_REV_INDEX` (64) and `ERROR_BITMAP` (128) no longer exist. The call sits in the
non-`--connectivity-only` branch, so none of those checks runs under `--connectivity-only`, and
`verify_pack` runs only under `--full`. Pinned on 2.56.0 against 2.55.0 in scrubbed throwaways: a
flipped `.idx` CRC exits 1 (was 4); a flipped `.rev`, `.bitmap` or midx checksum exits 1 (was 64,
128, 32) in default and `--no-full` modes and 0 under `--connectivity-only` (was the same bits);
stderr is byte-identical across the two versions. tsgit models each bit as its own constant and
evaluates the rev-index term in every mode (ADR-586).

## Options considered

1. **Delete the four constants; those passes OR in `EXIT_CORRUPT` (1)** — pros: mirrors git's
   source, no name suggests a bit that no longer exists / cons: every pinned exit literal in the
   fsck suites changes.
2. **Keep the four names as aliases equal to 1** — pros: smaller diff / cons: dead names that read
   as distinct bits.
3. **Keep the bits internally and remap them to 1 in a final fold** — pros: findings keep a bit
   each internally / cons: two exit vocabularies, one of them unobservable.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `EXIT_PACK`, `EXIT_MULTI_PACK_INDEX`,
`EXIT_PACK_REV_INDEX` and `EXIT_BITMAP` are removed; every pack, rev-index, bitmap and midx finding
contributes bit 1. The rev-index, bitmap and midx passes run only when `connectivityOnly` is not
set; the verify-pack pass runs only when `full` is not false. The finding variants are unchanged,
so a nonzero exit still has an explaining finding.

Superseded from ADR-586: exit bit 64 as a distinct value, and its evaluation in every mode.

Carried forward from ADR-586: the `pack-rev-index-unusable` finding variant for an unusable
`.idx`, emitted beside the index-layer finding in the modes where the pass runs.

## Consequences

- tsgit's fsck exit is 1, 2, 8, 16 or a sum of them; no value above 31 is produced.
- `fsck({ connectivityOnly: true })` reads no `.rev`, `.bitmap` or midx; `fsck({ full: false })`
  still runs those passes on the sources it audits (ADR-1108) but never verifies a pack.
- Every fsck interop row re-pins its exit literal against 2.56.0; the CI git pin (ADR-1117 to
  ADR-1120) keeps the expectation set tied to one version.
