# ADR-275: Consolidate the date-ordered commit walk onto an internal core

## Status

Proposed

Completes the follow-up logged by
[ADR-261](261-walk-commits-by-date-dedicated-primitive.md) ("unifying
`describe`'s bespoke date walk onto this primitive is **not** done here … logged
as a follow-up if it stays divergent").

## Context

Two date-ordered commit-walk loops coexist:

- the public Tier-2 primitive `walkCommitsByDate` (23.4b), now with a real
  consumer — the 23.4j-converged `log` — plus the queued `shortlog` / `range-diff`
  / `whatchanged` / `name-rev`;
- `describe`'s bespoke `selectNearest` scoreboard walk, entangled with
  candidate / reachability / depth bookkeeping.

The **ordering substrate** is already shared (`domain/commit/priority-queue.ts`,
ADR-259). What is still duplicated is the **walk-loop shell**: a seen-gated,
eager-read-at-enqueue, pop-then-discover-parents traversal over that queue. The
shell is generic mechanism; the candidate/reach/depth/cap logic is `describe`
policy — two concerns fused in one function.

ADR-261 deferred unifying them because rule-of-three was unmet and `describe`'s
walk looked too entangled to extract cleanly. Re-evaluating now that the third
consumer has landed, two facts changed the picture:

1. A **clean, behaviour-preserving** extraction exists that *reduces* `describe`'s
   size — it sheds `finishDepth` (the candidate-cap's two-phase re-enqueue dance
   collapses to single-pass consumption of an iterable) and its bespoke
   `makeCommitReader` / `toWalkCommit` / `WalkCommit` / `WalkState`. The fold
   removes more than it adds; it is not a wash that only over-design caution could
   justify declining.
2. The one obstacle is `firstParent`: `describe` needs it, but `walkCommitsByDate`
   has no first-parent path and no first-parent consumer (`log --first-parent`
   routes through `walkCommits`'s lazy FIFO). Putting `firstParent` on the
   **public** `WalkCommitsByDateOptions` would add public surface for a single
   internal caller — the over-design ADR-260/274 warns against.

Two decisions are therefore load-bearing: **(1)** fold vs weigh-and-decline (à la
23.4k), and **(2)** if folding, where `firstParent` lives.

### Options considered

- **Decline** (keep two loops) — zero churn, but declines a genuine
  simplification; *integrate-don't-defer* applies once a clean fold exists.
- **Fold via a public `firstParent`** — no new module, but widens `api.json` for
  one internal consumer and forces `describe` to re-derive the first-parent slice
  to match the primitive's internal parent selection (a new lockstep
  duplication).
- **Fold via an internal core** — one walk loop, `firstParent` internal,
  `api.json` unchanged, and a single `selectParents` shared between the core's
  traversal and `describe`'s reach-propagation (no lockstep duplication).

## Decision

**Fold, via an internal date-walk core.**

1. Extract `src/application/primitives/internal/commit-date-walk.ts` owning the
   generic loop (priority queue, `seen` gate, eager read, pop, parent discovery),
   parameterised by an internal `firstParent` flag. It exports the generator
   **and** `selectParents(commit, firstParent)` — the single source of truth for
   "which parents this walk follows."
2. `walkCommitsByDate` (public primitive) becomes a thin wrapper: it keeps its
   seed-validation contract (`INVALID_WALK_INPUT` for empty / too-many seeds) and
   delegates to the core with all-parents. `WalkCommitsByDateOptions` is
   **unchanged**; `firstParent` is **not** added to the public type.
3. `describe.selectNearest` consumes the core as an `AsyncIterable`, passing
   `firstParent: plan.firstParent`, and layers its candidate / reach / depth /
   cap policy in the consumer loop — reusing the exported `selectParents` for
   reach-propagation so the walk and the bookkeeping cannot drift.

The fold is **byte-for-byte behaviour-preserving**. Pop order is identical (same
`precedes`, same `seen`-gating, same parent selection). `describe`'s output is an
order-independent aggregate — `best.depth` is a sum over the commits that cannot
reach the winner, and `reach` sets are monotonic and complete-before-pop on any
causal date-order history — so the single-pass rewrite (which processes the
candidate-cap commit immediately rather than re-enqueuing it) yields the
identical `DescribeResult`. `walkCommitsByDate`'s observable stream is unchanged,
so `log` and all other consumers are untouched.

If a real public consumer ever needs date + first-parent (e.g. a future
`shortlog --first-parent`), promoting the core's flag to the public primitive is
a trivial additive, non-breaking step — deferred until demanded (YAGNI).

## Consequences

### Positive

- One date-walk loop in the codebase; the generic traversal and `describe`'s
  policy are cleanly separated (SoC), continuing the ADR-259 → ADR-261
  trajectory.
- `describe` shrinks: `finishDepth`, `makeCommitReader`, `toWalkCommit`,
  `WalkCommit`, `WalkState`, and the manual `enqueue`/`shift`/`seen` plumbing all
  disappear; its date handling moves into the core.
- Suppression reduction: several of `describe`'s `// Stryker disable`
  equivalent-mutant annotations on the bespoke walk vanish with the deleted code.
- `firstParent` stays internal — no public surface added for one internal caller;
  `reports/api.json` unchanged.
- `selectParents` gives reach-propagation and the walk a single source of truth,
  so the first-parent slice cannot drift between them.

### Negative

- A new internal module plus a thin public wrapper (rule-of-two on the loop
  shell). Accepted: this *is* the consolidation 23.4l asks for, and the core is
  internal — not speculative public surface.
- `describe`'s walk now depends on the core's parent-enqueue order for its depth
  accounting. Mitigated by the shared `selectParents` and the unchanged
  describe-interop / parity goldens, which pin the depths byte-for-byte.

### Neutral

- No git-observable change: SHAs, refs, reflogs, on-disk state, refusals, and
  structured outputs are identical; `describe` gains free abort support (the core
  checks `ctx.signal`), strictly additive.
- The lazy-vs-strict `--date-order` scope (ADR-261) is untouched; a strict mode
  remains deferred.
- `firstParent` on the public primitive remains a future additive option, not a
  removed capability.
