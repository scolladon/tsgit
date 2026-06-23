# 413 — object enumeration as a public primitive; reachability closure inline via set-difference

- **Status:** accepted
- **Date:** 2026-06-23
- **Design:** docs/design/fsck.md · **Relates:** ADR-226 (git-faithfulness)
- **Decision class:** D6 user-ratified · D5 adopted-as-recommended

## Context

fsck needs two capabilities the codebase lacks: a **whole-object-database enumeration** (loose
scan over `objects/<2hex>/<38hex>` ∪ every oid in every pack index) and a **full-graph
reachability closure** that classifies dangling vs unreachable objects. fsck is the *first*
consumer of object enumeration; later backlog items (`gc`, `prune`, `repack`, `bundle`) are
plausible future consumers. **D6:** where do the two capabilities live? **D5:** what algorithm
computes dangling/unreachable?

## Options considered

**D6 — placement:** (1) both inline/internal to fsck now, promote when a 2nd consumer lands
*(strict YAGNI)*; (2) **`enumerateObjects` public Tier-2 primitive now, closure inline**
*(designer rec)*; (3) both public now.
**D5 — closure algorithm:** (1) **full set-difference closure** *(designer rec)*; (2) git's
incremental lost-&-found sweep; (3) reachable-only (drop dangling/unreachable).

## Decision

**D6 → option 2 (user-ratified). D5 → option 1 (adopted-as-recommended).**

- **`enumerateObjects` ships as a public Tier-2 primitive** in `application/primitives/` now —
  the whole-object-DB scan (loose ∪ packed) is a generic capability `gc`/`prune`/`repack`/`bundle`
  will reuse, earning Tier-2 status ahead of the second consumer. It requires a small
  all-oid iterator addition to `domain/storage/pack-index.ts` (the sorted SHA table already
  exists; only the iterator is new).
- **The dangling/unreachable closure + classification stays inline** in `commands/fsck.ts` (with
  an internal helper module if needed) — it is fsck-specific verdict logic today; YAGNI keeps it
  un-promoted until a real second consumer appears.
- **Dangling/unreachable are computed by set-difference closure:** enumerate the universe `A`,
  BFS-mark the reachable set `Reach` from the roots (refs ∪ HEAD ∪ reflog oids ∪ index oids),
  `unreachable = A − Reach`, and `dangling` = the unreachable objects with **no in-edge from
  another present object** (the tips/roots of each unreachable subgraph). This is faithful to
  git's pinned tip-only-`dangling` vs all-`unreachable` distinction.

## Consequences

- Public surface gains `enumerateObjects` (+ its options/return types) in `reports/api.json` and
  the Tier-2 primitive list; the closure does not yet appear on the public surface.
- A future `gc`/`prune` PR promotes the closure to a primitive when it has a second user — not
  speculatively now.
- Set-difference is O(objects) in memory (the universe + the reachable mark-set); acceptable for
  a diagnostic command. git's incremental sweep (D5.2) is foreclosed as more machinery than the
  clean difference needs.
