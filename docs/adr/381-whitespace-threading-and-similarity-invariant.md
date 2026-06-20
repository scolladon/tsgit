# ADR-381: Whitespace mode threads through the primitive; similarity scoring stays whitespace-agnostic

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/whitespace-diff-options.md](../design/whitespace-diff-options.md)
- **Refines:** [ADR-373](373-detection-option-api.md)

## Context

A whitespace mode must reach the patch path (`buildEdits` → `diffLines`), the stat path
(`computeStatFields` → `diffLines`), and the file-drop pass (ADR-380) — all primitive-tier
concerns that read blob contents. It must NOT reach the three other `diffLines` callers
(`merge`, `blame`, `range-diff`), which stay byte-exact. A second, separately-pinned
question: does git apply the whitespace flags to rename/copy/break **similarity scoring**?

This was verified empirically (real git 2.54.0): a rename whose destination differs from
its source only in leading whitespace reports the **identical** similarity index and
pairing under `git diff -M` and `git diff -M -w`. git's diffcore-rename similarity
(`estimate_similarity` over spanhash counts) does not receive the xdiff whitespace flags —
they operate only in the textual diff. The reconnaissance had assumed the opposite.

## Options considered

1. **(chosen) Carry the mode on `DiffTreesOptions`**, thread from the primitive into the
   drop pass and the stat/patch path; `diffLines` gains an optional trailing options arg
   defaulting to exact compare — pros: one channel feeds drop + stat + patch consistently;
   the three exact-byte callers pass no mode and are provably unchanged / cons: a new
   optional key on `DiffTreesOptions`.
2. **Leaf-only** (mode only on `diffLines`, set at the patch/stat leaves) — Rejected:
   the file-drop pass lives in the primitive and needs the mode there; leaf-only cannot
   express the drop.
3. **Compute the drop in the domain classifier** — Rejected: the classifier is pure and
   OID-only; the drop needs blob I/O (dependency-rule violation).

## Decision

`DiffTreesOptions` (and the public `DiffOptions`) carry the ADR-378 whitespace fields.
`diffTrees` resolves them and threads them into the drop pass and the stat/patch path.
`diffLines` takes an optional trailing options argument; absent ⇒ exact `bytesEqual`
(today). `merge`, `blame`, and `range-diff` pass no options and are byte-unchanged.

The rename/copy/break **similarity pipeline is not touched** by this feature:
`estimateSimilarity`, `detectSimilarityRenames`, and `buildChunkMap` continue to score on
raw bytes. Applying whitespace normalization to spanhash fingerprinting would **diverge**
from git. An interop assertion pins `-M -w ≡ -M` as a regression guard.

## Consequences

- The default (no-mode) diff path is unchanged: OID-only classification, no blob reads.
- merge/blame/range-diff are safe by construction (default = exact compare); a unit test
  pins their `diffLines` calls as byte-identical.
- A whitespace-only rename still pairs and scores exactly as without `-w`, since
  similarity ignores whitespace; the ADR-380 drop only removes whitespace-only *modifies*,
  never affecting rename scoring.
- `diffLines`' optional options arg is additive and backward-compatible for all callers.
