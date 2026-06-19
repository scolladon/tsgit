# ADR-372: `CopyChange` mirrors `RenameChange` (two-sided + similarity, source retained)

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)
- **Refines:** [ADR-367](367-rename-change-shape.md), [ADR-369](369-copy-break-threshold-scope.md)

## Context

Copy detection (ADR-369) introduces a `copy` outcome: an `add` paired against a
**retained** source (the source is not consumed, unlike a rename source). git reports
it as `C<score>` (`--name-status`) / `copy from`/`copy to` (patch). It needs a
structured `DiffChange` representation. ADR-367 already established the two-sided +
`similarity` convention for renames and said a `copy` follows it.

## Options considered

1. **(chosen) Two-sided `CopyChange`** — `oldPath/newPath/oldId/newId/oldMode/newMode`
   + `similarity`, discriminant `'copy'`, source retained. Pros: mirrors
   `RenameChange` 1:1 so the serializer shares the rename renderer (only the
   `from`/`to` keyword differs); the greedy matrix treats both uniformly. Cons: a near-
   duplicate interface (intentional — they differ only in source-consumption semantics).
2. **Reuse `RenameChange` + a `consumesSource: boolean`** — one variant carrying a
   behavioural flag. Rejected: overloads a type with behaviour; consumers must branch
   on a flag rather than the discriminant.
3. **Minimal `{ fromPath, toPath, similarity }`, resolve ids/modes from the source's
   own change** — Rejected: the index line needs the source **preimage** oid, which is
   not derivable when the source is unchanged (`--find-copies-harder`).

## Decision

A new `CopyChange` joins the `DiffChange` union and `DiffChangeType` (`'copy'`):
`{ type:'copy', oldPath, newPath, oldId, newId, oldMode, newMode, similarity }`.
`oldId` is the source **preimage** blob (scored side, patch left side); the source is
**not** removed from the diff (its own add/modify/unchanged entry survives alongside
the `copy`). The patch serializer branches on `type === 'copy'` to emit
`copy from`/`copy to`; all other lines (similarity index, mode preamble, index, hunk)
are shared with the rename renderer.

## Consequences

- `change-path.ts`, `materialise-patch-files.ts`, `patch-serializer.ts`,
  `range-diff/patch-text.ts` gain a `copy` case; `blame.ts` is unaffected (copies don't
  move blame).
- The public type surface gains `CopyChange`; the re-export barrel and `api.json` update.
- R100-style exact copies are `similarity.score === MAX_SCORE` (header stops after
  `copy to`, no index/hunk), exactly mirroring the R100 rename shape.
