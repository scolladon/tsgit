# 470 — enforce the tarball cap in the per-PR gate

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/bundle-size-optimization.md · **Relates:** ADR-468, ADR-469

## Context

`verify:tarball` runs only on tag-push CI — it is **not** in the `validate` wireit
dependency list. With the cap re-tightened (ADR-469), a size regression (a fat
new dependency-free module, or source maps sneaking back past ADR-468) would be
invisible until release, where it blocks the release rather than the PR that
caused it. The point of re-tightening is to *keep* the tarball tight, which
needs a guard at the cadence where regressions are introduced: per PR.

## Options considered

1. **Lightweight PR gate now** — fold a tarball-size + `*.map` forbidden-path
   check into the per-PR gate (`validate`/CI) in this change. Catches bloat and
   returning maps at the PR that causes them. Cost: one `npm pack` per gate run.
   Does **not** re-run `attw` (that stays with the existing `check:exports`), so
   no double-attw.
2. **Tag-push only** (status quo) — leave `verify:tarball` at release cadence.
   Cheapest, and the cap still guards the actual published artefact — but a
   regression surfaces only at release. *(design recommendation)*
3. **Full `verify:tarball` in `validate`** — wire the whole script in. Also runs
   `attw --pack` per PR, overlapping `check:exports` (double-pack + double-attw).
   Most coverage, most redundancy.

## Decision

Adopt option 1 — **a lightweight tarball-cap + `*.map` guard runs in the per-PR
gate** (user-ratified; **deviates from the design's recommendation** of
tag-push-only). The user's standing delivery preference is to land the full guard
in this change rather than defer PR-time enforcement to a follow-up. The
per-PR check asserts the compressed-tarball size cap (ADR-469) and the
`*.map`-forbidden-path guard (ADR-468); it deliberately leaves `attw` resolution
to the existing `check:exports` to avoid the double-attw of option 3.

The design's tag-push `verify:tarball` invocation is retained (it still guards the
published artefact at release, and owns the `attw` resolution check); the per-PR
gate is the additive lighter check, not a replacement.

## Consequences

- Size/map regressions are caught at the PR that introduces them, not at release.
- One `npm pack` is added per per-PR gate run. `check:size` (per-file gzip) and
  `check:exports` (`attw --pack`) are unaffected; the only new pack is the
  lightweight size+inventory check, which does not duplicate the attw resolution.
- The design's D3 recommendation (tag-push-only, PR enforcement as a follow-up) is
  superseded by this decision and is reconciled in the against-ADRs design
  revision — the enforcement lands in this change, honouring the no-follow-ups
  delivery default.
- The exact wiring point (a new `verify:tarball` wireit dependency in `validate`
  vs a dedicated lightweight script/CI job) is settled in planning; the invariant
  fixed here is *the cap + map guard run per PR*.
