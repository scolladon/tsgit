# ADR-239: Keep `walkTree` / `walkWorkingTree` public — the snapshot is additive

## Status

Accepted (at `e457a551`) — revisits [ADR-152](152-semver-2-0-0-and-deprecation-cycle.md)

## Context

[ADR-152](152-semver-2-0-0-and-deprecation-cycle.md) chose to ship 20.1 as
2.0.0 and deprecate the old walkers (remove in 3.0.0), on the assumption that
the snapshot+join surface *replaces* them. Working through the consumer
migration showed that assumption is false — the snapshot is a **higher-level
construct built on top of the walkers**, not a replacement:

- `TreeSnapshot.entries()` yields **leaf entries only** (files / symlinks /
  submodules); it skips subtree/directory entries, so it cannot enumerate a
  tree's structure the way public `walkTree` does (`git ls-tree -t`).
- `WorkdirSnapshot` exposes a **reduced `WorkdirStat`** (path / kind / mode /
  size / mtime / ino), not the raw `FileStat` (ctime / dev / uid / gid) that
  `walkWorkingTree` yields and that `add` / `stash` rely on for their
  TOCTOU-hardened staging.
- The snapshot resolvers (`tree-snapshot`, `fs-workdir-enumerator`) are
  *implemented via* the walkers, and `enumerate-push-objects` (needs tree
  oids) + `walk-submodules` (Tree-object input, cross-store recursion)
  genuinely require the lower-level walkers.

tsgit's stated value is *"commands are built from primitives — the same
building blocks users get."* Removing the low-level primitives because a
high-level convenience exists works against that and drops real
capabilities (full-tree-structure walking, raw working-tree stat).

An exploratory pass migrated `status` / `checkout` onto the snapshot. With
the walkers staying, that only added indirection + an upward
`command → adapter → snapshot → adapter → walker` path to reach the *same*
walker call — no caching/laziness benefit for single-pass enumeration. It was
reverted as needless indirection.

The layering is one-way (hexagonal): walker = low-level enumeration
**primitive**; snapshot = **higher-level** read construct built on it.
Higher depends on lower, never the reverse.

## Decision

Keep `repo.primitives.walkTree` and `repo.primitives.walkWorkingTree` as
public, first-class, **non-deprecated** primitives. The snapshot+join surface
(`repo.snapshot.*`) is the **recommended high-level read path** but it is
purely **additive** — it neither replaces nor deprecates the walkers, and **no
internal consumer is routed through it**: every command and primitive calls
the walkers directly; the snapshot resolvers wrap the same walkers for the
public API.

- 20.1 is complete: the snapshot surface shipped (Wave 1, #81); recognising it
  as additive is the close-out. No consumer migration, no walker disposition
  change.
- The one-way layering is **enforced**, not just intended: a
  `primitives-cannot-import-adapters` rule in `.dependency-cruiser.cjs` stops
  a primitive from reaching up into the snapshot factory / adapter
  composition (the edge that made the exploratory primitive migration wrong).
- 2.0.0 is cut by the already-merged-but-unreleased breaking changes
  (array-only `mergeBase`, namespace-only CRUD porcelain) via release-please
  (`Release-As: 2.0.0` + a `BREAKING CHANGE:` footer). No breaking change
  originates in this work.
- No future walker/snapshot consolidation is planned — they are intentionally
  two abstraction levels over one traversal engine.

## Consequences

### Positive

- No capability regression: subtree enumeration + raw working-tree stat stay
  available to users.
- Honors the primitives-first-class value; the snapshot is a genuine
  convenience layer, not a forced replacement.
- Smallest, lowest-risk close-out: no consumer migration, no walker removal,
  no security-critical staging rework. The diff is documentation + the 2.0.0
  cut + the layering guardrail.
- The walker-below-snapshot direction is lint-enforced, so the boundary can't
  silently rot.

### Negative

- A low-level walker and a high-level snapshot both enumerate trees / the
  working tree. Accepted: they sit at different abstraction levels
  (intentional), the dependency is one-way and lint-guarded.

### Neutral

- ADR-152's "ship as 2.0.0" half stands; its deprecation-cycle half is dropped
  (no deprecation, no planned 3.0.0 removal). ADR-152 is marked superseded by
  this ADR.
