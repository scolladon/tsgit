---
subjects:
  - src/application/primitives/internal/index-pack.ts
  - src/application/primitives/fetch-pack.ts
---
# 779 — Pass 2 resolves deltas root-down, not by ordinal sweep

- **Status:** accepted
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-1) · **Supersedes/Refines:** none

## Context

The index pass over a received pack must reconstruct every delta entry to compute its oid.
Today it holds every entry's inflated content in memory at once. Replacing that requires
choosing how pass 2 finds a delta's base once the content is no longer retained. The backlog
entry sketched an offset-ordered sweep resolving bases through a size-budgeted cache; measuring
`git index-pack` under a `core.deltaBaseCacheLimit` sweep showed git rests on a memory-safe
resolution algorithm and layers its cache on top purely for speed.

## Options considered

1. **Child-indexed forest walk** (designer's recommendation) — roots are the base entries;
   children are found by base offset and base oid; a parent's content sits on an explicit stack
   and is released when its last child is resolved. Pros: each delta applied exactly once, each
   entry read at most twice, cycles structurally unreachable, no budget to tune. Cons: pass 2 is
   a walk rather than a flat loop.
2. **Offset-ordered sweep with a byte-capped LRU base cache** — the backlog's sketch. Pros: pass
   2 stays a flat loop. Cons: correctness of the *cost* depends on cache hits; a fully-missing
   cache costs `Σ_i depth(i)` delta applications — measured 8 474 against 296 on a 903-object
   fixture — and the budget needs a config key to pin.
3. **Forest walk plus an LRU for externally-resolved thin-pack bases** — the walk of option 1,
   with a cache confined to the thin-pack seam.

## Decision

**User-ratified: option 3.** Pass 2 is the root-down forest walk. Roots are enumerated by entry
type, so a base sitting after its dependents is still found; children are located through the
record store's two child indexes; a parent's content is released the moment its last child is
dequeued, which is the single behaviour the retained-ancestor memory term depends on. Recursion
is an explicit stack, never the JS call stack.

A `resolved` flag guards each child. A pack may legally carry the same oid twice (pinned: git's
default fetch accepts it, `transfer.fsckObjects` defaults false), which makes a REF delta keyed
on that oid a child of two parents; without the guard it would be applied twice and the resolved
count would overshoot the declared object count.

The cache half of option 3 is settled separately by ADR-788, which resolves it into one cache
serving both the carry-over and thin-pack roles rather than a thin-pack-only structure.

## Consequences

Delta resolution is O(entries) rather than O(passes × entries), and unresolved entries are
discovered as a set — which is what makes ADR-784's counting refusal free. Cycles and
unreachable deltas cost nothing: the walk never visits them, so termination is structural rather
than a no-progress check. Pass 2's reads jump backwards through the pack, which retires the
`windowCovering` equivalence proof that assumed a forward-only anchor.
