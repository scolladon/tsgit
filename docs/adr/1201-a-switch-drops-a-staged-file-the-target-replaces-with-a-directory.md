---
subjects:
  - src/application/primitives/materialize-tree.ts
  - src/application/commands/checkout.ts
---
# 1201 — A switch drops a staged file the target replaces with a directory

- **Status:** accepted
- **Date:** 2026-11-17
- **Design:** docs/design/checkout-branch-on-unborn-head.md (D5) · **Supersedes/Refines:** none

## Context

A staged file `dir` that HEAD does not hold, and a target that holds `dir/x`: git switches (exit
0, three runs), drops the staged `dir` from the index and the disk, and writes `dir/x`. It does
this from an unborn HEAD (row G1, which this change makes reachable) and from a born one (row G9,
on main today). tsgit refuses `CHECKOUT_OVERWRITE_DIRTY { untracked: ['dir'] }`. The cause is in
`materializeTree`'s two-way carry (`carryHeadAgreement` / `agreementWithHead`), a primitive every
switch, `reset` and merge uses; the one-way path already matches git.

Those runs were taken under `core.ignorecase=true`. With `false`, git refuses as tsgit does, except
that tsgit leaves both `dir` and `dir/x` in the index when no file stands at `dir`. ADR-1202
refines what the fold replicates.

## Options considered

1. **Leave it out** (design's recommendation) — ship G1 as a known difference and defer the carry
   fix to impact triage.
2. **Fold it** — fix the two-way carry in this change, with its own unit rows and interop pins for
   G1 and G9.

## Decision

**ratified by the user** — option 2, applying doctrine D-2: a pinned row this change makes
reachable is not left red because its cause sits in a shared primitive. The deferred impact on
`materialize-tree.ts` is folded rather than triaged.
