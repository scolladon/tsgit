---
subjects:
  - src/domain/objects/encoding.ts
  - src/domain/path/verify-path.ts
  - src/domain/objects/tree-entry-bytes.ts
---
# 1149 — git's UTF-8 picker lives once in encoding

- **Status:** accepted
- **Date:** 2026-11-06
- **Design:** docs/design/fsck-raw-byte-dotgit-alias.md · **Supersedes/Refines:** refines ADR-978

## Context

git has one `pick_one_utf8_char`. tsgit's index-path check carries its rules in
`src/domain/path/verify-path.ts` (`gitPickerValidPrefix`, built on `wellFormedSequenceLength`
from `src/domain/objects/encoding.ts` plus a U+FFFE/U+FFFF patch), and the tree-entry fold
needs the same rules. `verify-path.ts` already imports from `tree-entry-bytes.ts`, so the fold
cannot import the picker from `verify-path.ts` without a cycle; `encoding.ts` imports nothing.

## Options considered

1. **Move the picker into `encoding.ts`; `verify-path.ts` imports it** — pros: one
   implementation, next to the validator it extends, behaviour-preserving, the moved tests move
   with it / cons: touches `verify-path.ts` for an import. The designer's recommendation.
2. **A second copy in `encoding.ts` or `tree-entry-bytes.ts`, `verify-path.ts` untouched** —
   cons: two pickers that can drift, which is how the index side's U+FFFE gap arose.
3. **Export the picker from `tree-entry-bytes.ts`** — pros: no cycle / cons: a UTF-8 primitive
   in a tree-entry module.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-978 (one picker rule on both sides)
and no trade-off beyond mechanics: option 1.** `encoding.ts` exports
`gitPickerSequenceLength(bytes, at)` (git's accept length, 0 on rejection) and
`gitPickerValidPrefix(bytes)`; the non-character helpers are private there. `verify-path.ts`
imports `gitPickerValidPrefix`; `tree-entry-bytes.ts` imports `gitPickerSequenceLength`. None
of these symbols is public.

## Consequences

- Every existing verify-path test passes with only import paths edited; the
  `gitPickerValidPrefix` table moves to the encoding suite unchanged.
- A future divergence between git's picker and the Unicode validator is fixed in one place.
