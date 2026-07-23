# 497 — A registered-but-driverless merge driver refuses lazily

- **Status:** accepted (user judgment — chose to close the divergence in this PR)
- **Date:** 2026-07-23
- **Design:** docs/design/merge-driver-config-override.md · **Supersedes/Refines:** refines ADR-303, ADR-352

## Context

Pinning ADR-496 against git 2.55.0 surfaced a **separate, pre-existing** divergence. When a
`[merge "<name>"]` section registers a user driver entry — git creates one on the *first*
`merge.<name>.<key>` it parses — but configures **no** `driver` command, and that name is
selected for a content merge, git dies **lazily** at dispatch:
`fatal: custom merge driver <name> lacks command line.` (exit 128). Confirmed live and pinned
(design matrix M4/M5/M8/M10; an *unused* driverless section stays inert — M9). tsgit instead
falls back to the built-in text merge. ADR-303's row "`'<name>'` without a configured `driver` →
fall back to built-in text (git's behaviour)" is therefore empirically imprecise.

This is **distinct** from ADR-352's guard: ADR-352 refuses **eagerly** and whole-table for a
**valueless** key (`[merge "x"] driver` / `name` with no `=`, exit 128 `missing value for
merge.x.driver`, matrix M11/M12/M15). The driverless case here has a **valued** key but no
`driver` command, and git's refusal is **lazy** — only when the driver is actually selected.

The core ADR-496 fix (the driver-*present* override) is complete without touching this; closing
the driverless gap is a deliberate, ratified scope choice honouring the git-faithfulness prime
directive (ADR-226).

## Options considered

1. **Fix now — reproduce the lazy refusal** (chosen) — faithful; closes M4/M5/M8/M10. / cons: a new
   `MergeDriverChoice` variant + a new error constructor + a per-path throw at the content-merge
   chokepoint, plus one residual (below).
2. **Bounded — keep today's fall-back-to-text** (the design's recommendation for minimal scope) —
   zero new divergence, smaller PR. / cons: leaves the pre-existing divergence and ADR-303's
   imprecise row standing.

## Decision

When the resolved driver name has a **registered but driverless** config entry — a non-empty
record (`name` and/or `recursive` set) with no `driver` command — resolution yields a
`missing-command` choice carrying the name. The content-merge chokepoint (`buildContentMerger`)
throws git's `custom merge driver <name> lacks command line.` refusal **per-path, at dispatch**,
so an unused driverless section stays inert (M9). The eager valueless guard (ADR-352) is unchanged
and continues to fire first for valueless keys (M15 refuses even with a valued `driver`).

**Residual (documented, not a goal):** git registers a driver entry on the first key of *any*
name, so an unknown-key-only `[merge "x"] foo = bar` refuses when selected (M16). tsgit's `merge`
map records only `name`/`driver`/`recursive`, recording both an unknown-key-only section and an
**empty** section as `{}`; it cannot distinguish M16 from M17. The `missing-command` rule keys off
a **non-empty** record, so it matches git for the common driverless section (M4/M5/M8/M10) and the
empty section (M17 → text), diverging only for the exotic unknown-key-only section (M16), which
tsgit does not model.

## Consequences

- Closes the driverless divergence for its common shape (a `name`/`recursive`-carrying section with
  no `driver`) and stays faithful on the empty-section (M17) and unused-section (M9) cases;
  interop-pinned against real git.
- Refines ADR-303's imprecise driverless row and sits beside ADR-352 as the **lazy** counterpart to
  its eager valueless refusal.
- Adds a bounded refusal surface (one new choice variant, one new error) and one documented residual
  (M16) tied to tsgit's config-map model.
