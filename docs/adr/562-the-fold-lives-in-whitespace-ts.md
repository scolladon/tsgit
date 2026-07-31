# 562 — The incremental fold lives in `whitespace.ts`; `digestNormalizedLine` drives it

- **Status:** accepted
- **Date:** 2026-07-31
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

ADR-558 settled *that* the digest fold becomes incremental but left its exact shape open,
and with it the question of where the fold lives and what happens to the four whole-line
folders it replaces. Verified precondition: `digestNormalizedLine`, `digestsEqual`,
`digestIsBlank` and `LineDigest` are **internal** — absent from both
`src/domain/diff/index.ts` and `src/public-types.ts` — so no option here touches public
surface.

## Options considered

1. **The fold lives in `whitespace.ts`** as `createLineDigestFold(key)` (push-byte /
   end-line); `digestNormalizedLine(bytes, key)` is re-expressed as a thin whole-line
   driver of it, keeping its signature; the scanner drives the same fold directly
   (designer's recommendation).
2. **The fold lives in `line-digest-scanner.ts`**; `whitespace.ts` keeps today's four
   whole-line folders as a reference implementation — cons: two implementations of one
   rule, drift caught only by the property test; the exact failure mode ADR-551 exists to
   prevent, and ADR-557/559's rules would then have to be applied twice.
3. **The fold lives in the scanner and `digestNormalizedLine`, the four folders and
   `digestContentEnd` are deleted** — the smallest end state, but it relocates ~40 pinned
   digest rows out of `whitespace.test.ts` in the same commit that rewrites the thing they
   pin, and spreads the domain's digest rule across two files.

## Decision

Adopted-as-recommended (no user judgment): **option 1**.

## Consequences

One rule with one implementation — ADR-551's argument applied one layer down. It also
keeps the bit-identity property a *real* property rather than a tautology for free:
`whitespace.test.ts`'s `expectedDigest` helper derives the expected digest from
`normalizeLine`'s output (allocate the normalized array, then FNV over it), which is a
genuinely separate implementation rather than a copy of the subject under test — so the
property has an independent oracle without anyone writing one. All ~40 existing
`digestNormalizedLine` rows keep passing unchanged, and they are the regression net for
the rewrite. `digestNormalizedLine` survives as a wrapper whose signature does not move,
so every current caller is unaffected.

## Later refinement (post-acceptance)

The push-byte / end-line shape described above — `applyContentByte` classifying one byte
at a time via `isSoftWs`/`isSoftCr` and dispatching to `onHard`/`onSoftWs`/`onSoftCr` —
was replaced by a separate performance refactor after this ADR was accepted: a fold
micro-benchmark (design's Results section) showed the per-byte call chain regressing
4.9×–15.6× against the four whole-line folders it replaced. The driver now folds a
`[from, to)` chunk range per call (`pushChunk`, not a per-byte `push`), classifies each
byte through a precomputed 256-entry byte-kind lookup table instead of two per-byte
predicate calls, and collapses the two `pendingWs`/`pendingCr` booleans into one `tail`
state. The decision this ADR records is unaffected: the fold still lives in
`whitespace.ts`, and `digestNormalizedLine` is still the thin whole-line driver over it,
signature unchanged.
