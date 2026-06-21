# ADR-400: `log` parent-count filter — numeric min/maxParents, post-walk output filter

## Status

Accepted

- **Date:** 2026-06-21
- **Design:** [design/diff-faithfulness-odds-ends.md](../design/diff-faithfulness-odds-ends.md) §3
- **Refines:** [ADR-249](249-describe-structured-data-only.md) (structured output)
- **Relates to:** [ADR-275](275-consolidate-date-walk-internal-core.md) (commit-date walk core)

## Context

`log` cannot answer "give me the root commits" (or "only merges" / "no merges")
without the consumer walking the full history and post-filtering
`parents.length === 0`. git exposes this directly via `rev-list --max-parents=<n>` /
`--min-parents=<n>` (roots = `--max-parents=0`, merges = `--min-parents=2`,
no-merges = `--max-parents=1`, no-roots = `--min-parents=1`). The brief asks for a
`maxParents`/roots filter for cheap root-commit lookup.

Pinned against real git (two-root history merged into main): the parent-count filter
is an **output filter, not a traversal pruner** — git still follows all parents (so
`--max-parents=0` reaches every root through the merge) and only drops commits from
the output. Critically, `--max-parents=1 -n 1` returns the newest **non-merge**
commit: git applies the parent-count filter **before** `-n`. So `log` must
**filter-then-limit**.

## Options considered

- **API shape:** (a) numeric `minParents?` / `maxParents?` pair on `LogOptions`;
  (b) a narrow `roots?: boolean`; (c) both. **Chose (a)** — git-faithful and fully
  general (roots, merges, no-merges, no-roots, octopus bands), structured-data-only
  (numbers, not a rendered string). (b) cannot express merges/octopus; (c) adds a
  redundant field (a) already subsumes.
- **Filter location:** (a) post-walk in `log.ts` (alongside the existing `before`
  filter); (b) threaded into the walk primitives (`walkCommits` / `commitDateWalk`).
  **Chose (a)** — the predicate is pure and I/O-free (every `Commit` already carries
  `parents`), so there is no traversal-cost reason to push it down; keeping it in
  `log.ts` avoids widening the shared walk-primitive contract that `blame` and other
  consumers depend on.

## Decision

Add `minParents?: number` and `maxParents?: number` to `LogOptions`. A commit is
kept iff:

```
(minParents === undefined || parents.length >= minParents) &&
(maxParents === undefined || parents.length <= maxParents)
```

The predicate runs **post-walk in `log.ts`**, at the same point as the existing
`before` filter; the `limit` break fires only after both `before` and the
parent-count predicate pass (**filter-then-limit**). The walk itself is unchanged —
all parents are still followed, so `maxParents: 0` from a multi-root tip returns
every reachable root. The predicate reads the commit's **true** parent count, so it
composes correctly with `order: 'first-parent'` (a merge still counts as ≥2 parents).

Edge semantics pinned: `minParents > maxParents` → empty; octopus merges handled by
the numeric band; default (neither field) → today's output byte-identical.

Threading parent-count into the walk primitives is rejected; named `--no-merges` /
`--merges` boolean aliases are not added (the numeric pair subsumes them, matching
git's own internal modelling).

## Consequences

### Positive

- One git-faithful, fully-general option pair replaces consumer-side full-history
  post-filtering; cheap root-commit lookup is a direct `maxParents: 0` call.
- `blame` and the shared walk primitives are byte-unaffected.

### Negative

- The consumer learns two numeric fields rather than a `roots` convenience boolean —
  accepted; the generality (merges/octopus) is worth it and the `roots` semantics are
  a single obvious value (`maxParents: 0`).

### Neutral

- The filter is an output filter; walk reachability and order are unchanged.
