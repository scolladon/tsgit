# ADR-152: 2.0.0 semver-major and deprecation cycle for old walkers

## Status

Superseded by [ADR-239](239-keep-walkers-public-snapshot-additive.md)

Originally Accepted (at `1c35bc3`). The "ship as 2.0.0" half stands. The
deprecation-cycle half (deprecate the walkers, remove in 3.0.0) is dropped by
ADR-239: investigation showed the snapshot does **not** subsume the walkers
(no subtree enumeration; reduced working-tree stat), so they are kept public
as first-class primitives — neither deprecated nor removed. The snapshot is
an additive higher-level layer built on them.

## Context

`repo.primitives.walkTree` and `repo.primitives.walkWorkingTree` are
**published public API surface** — declared in `repository.ts:151-152`,
included in `reports/api.json`, documented at `docs/use/primitives/`,
referenced in `docs/get-started/migrate-from-isomorphic-git.md`.

Removing them is a semver-major breaking change. Two paths:

1. **1.4.0 with internal facades** — rename internally, keep public methods
   pointing at the new implementation. Backwards-compatible. Surface stays.
2. **2.0.0 with deprecation cycle** — mark old methods `@deprecated`, ship
   with runtime warnings, remove in 3.0.0.

Option 1 keeps the API contract honest about behavior (same surface, same
semantics) but freezes a positional-tuple, async-getter API the spike
explicitly designed to replace. Future users who reach for `walkTree` find
the old API forever.

Option 2 communicates honestly that we want users to migrate. The new API
is the recommendation; the old one is on a removal track.

## Decision

Ship as **2.0.0** (current `package.json` is `1.3.0`). Old walkers stay
exported through the 2.x line as `@deprecated` facades that delegate to
the new `TreeSnapshot.entries()` / `WorkdirSnapshot.entries()` under the
hood. Runtime warning on first call per call-site, gated by
`TSGIT_SUPPRESS_DEPRECATIONS=1` (see ADR-160).

Removal in **3.0.0** — no fixed date. The 2.x line stays supported as long
as users have a reasonable migration path; 3.0.0 ships when migration is
broadly complete and / or 3.0 work has its own justification.

`README.md` and `migrate-from-isomorphic-git.md` update in the same PR as
Wave 8.

## Consequences

### Positive

- Semver-honest. Users on 1.x know exactly what changes in 2.0.
- Migration recipe documented; runtime warnings nudge users toward the new
  API on every use site.
- 20.1 is the natural 2.0 anchor — a foundational API change deserves a
  major bump.
- 3.0.0 has time to plan; not rushed.

### Negative

- Faster major-bump cadence than 1.x→2.0.0 might have implied. Mitigated:
  the spike itself documents the rationale; this isn't churn for churn's sake.
- Two surfaces (deprecated + new) live in 2.x. Doubles the public API
  documentation burden temporarily.

### Neutral

- Wave 8 (the deprecation wave) is the only Wave that MUST land in the same
  PR as Wave 1; Waves 2–7 can split if needed (per ADR-151).
- Existing changelogs and `RUNBOOK.md` note the deprecation behavior and env
  var (see ADR-160).
