# ADR-374: A kept-broken rewrite is one `modify` + optional dissimilarity datum

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)
- **Refines:** [ADR-368](368-similarity-score-unit.md), [ADR-369](369-copy-break-threshold-scope.md)

## Context

Break detection (`-B`, ADR-369) splits a sufficiently-dissimilar `modify` so its halves
can feed rename/copy detection. When no half is consumed and the dissimilarity clears
the keep-broken gate, git surfaces the result as a **single** `modify` at one path
carrying a `dissimilarity index <n>%` (patch) / `M<n>` (`--name-status`) — **not** two
separate `D`+`A` entries (pinned against git 2.54.0). The structured representation must
reproduce that observable shape.

## Options considered

1. **(chosen) One `modify` variant + optional `broken?: SimilarityScore`** — the
   `broken` score carries the **dissimilarity** raw value (`MAX_SCORE − similarity`);
   the serializer emits `dissimilarity index toSimilarityPercent(broken.score)%` and
   `M<n>` when present. Pros: byte-faithful to git's single-path `M<n>`; no new union
   member; reuses the ADR-368 score shape. Cons: `ModifyChange` gains an optional field.
2. **Split a kept-broken modify into a `delete`+`add` pair** — Rejected: diverges from
   git's `--name-status` (git shows `M100`, not `D`+`A`) and mis-drives consumers that
   count adds/deletes.
3. **A new `break` change type** — Rejected: union churn for a state git models as a
   modify.

## Decision

`ModifyChange` gains `broken?: SimilarityScore`, present iff `-B` kept the modify
broken; `broken.score` is the dissimilarity (`MAX_SCORE − similarity`). The patch
serializer renders `dissimilarity index <p>%` (and `--name-status` `M<p>`) when
`broken` is present, else the normal modify body. When a broken half is instead
consumed by a rename/copy, the outcome is expressed by that `rename`/`copy` (no
`broken` flag needed).

## Consequences

- A complete rewrite is representable without leaving the `modify` variant; the
  `dissimilarity index` text reconstructs byte-for-byte.
- `toSimilarityPercent` projects both similarity (renames/copies) and dissimilarity
  (broken modifies) — one projection, two callers.
- Consumers that ignore `broken` see an ordinary `modify` (graceful degradation).
