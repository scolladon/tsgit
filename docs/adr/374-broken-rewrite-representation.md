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
broken. `broken.score` is git's **dissimilarity** for the rewrite. The patch
serializer renders `dissimilarity index <p>%` (and `--name-status` `M<p>`) when
`broken` is present, else the normal modify body. When a broken half is instead
consumed by a rename/copy, the outcome is expressed by that `rename`/`copy` (no
`broken` flag needed).

### Dissimilarity formula (corrected)

The dissimilarity is git's `diffcore-break.c` **`merge_score`**, NOT the rename
similarity complement. git computes it as

```
merge_score = (src_size − src_copied) · MAX_SCORE / src_size
```

where `src_copied` is the spanhash-counted bytes of the source that survive into the
destination. This shares `src_copied` with the rename similarity but divides by
`src_size` (not `max(src_size, dst_size)`), so it is **not** `MAX_SCORE − similarity`
whenever the two sides differ in size. The original draft's `MAX_SCORE − similarity`
was a wrong simplification: verified against git 2.54.0, a 20-line / 9-shared rewrite
reports rename similarity `R039` but break dissimilarity `M055` (`100 − 39 ≠ 55`),
and the wrong formula flips git's default-gate **re-merge** into a tsgit kept-broken
modify — an observable `--name-status` / on-disk divergence, not a cosmetic one.

The break-**attempt** gate uses git's `break_score`
(`min(src_removed + literal_added, max_size) · MAX_SCORE / max_size`); the
**keep-broken** gate and the printed index use `merge_score`. Both are pinned
byte-for-byte against real `git` across the break matrix (the empirical pin is the
authority; this formula is the guide).

## Consequences

- A complete rewrite is representable without leaving the `modify` variant; the
  `dissimilarity index` text reconstructs byte-for-byte against real git.
- The scorer must expose git's raw counts (`src_copied`, `literal_added`), not only
  the final similarity score, so the break pass can compute `merge_score`/`break_score`.
- `toSimilarityPercent` projects both the similarity (renames/copies) and the
  dissimilarity `merge_score` (broken modifies) — one projection, two callers.
- Consumers that ignore `broken` see an ordinary `modify` (graceful degradation).
