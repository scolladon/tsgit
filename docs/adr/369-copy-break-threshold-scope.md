# ADR-369: Ship copy detection, break detection, and configurable threshold with similarity renames

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)

## Context

Backlog 24.13 is scoped as "similarity rename detection". The design recommended
shipping *only* inexact renames at git's fixed 50% default and deferring copy
detection (`-C`), break detection (`-B`), and configurable threshold
(`-M<n>`/`-C<n>`/`-B<n>`) as separate items, each a distinct diffcore pass with its
own faithfulness matrix. The user decided to widen scope and land all of it in this
change — the whole diffcore find-renames/copies/breaks surface — rather than spread it
across four follow-up PRs.

## Options considered

1. **Rename similarity at fixed 50% only** (design recommendation) — smallest faithful
   increment; `-C`/`-B`/threshold deferred. Pros: bounded matrix; one feature. Cons:
   leaves the diffcore surface incomplete across four PRs.
2. **Also configurable threshold now** — adds `renameOptions.threshold`; `-C`/`-B`
   later. Middle ground.
3. **(chosen) Ship `-C` + `-B` + threshold all now** — copy detection, break
   detection, and configurable threshold land alongside inexact renames. Pros:
   completes the diffcore detection surface in one coherent, byte-faithful change;
   matches the user's "everything in this PR" preference. Cons: substantially larger
   faithfulness surface — three additional pinned matrices (copies, breaks, threshold
   sweeps) in one PR.

## Decision

This change ships the full diffcore detection surface, each byte-faithful to real
`git` and pinned by interop:

- **Inexact renames** at the configurable threshold (default 50%).
- **Copy detection (`-C`)** — pair an `add` against an unchanged source; reported as a
  `copy` change (`C<score>`). `--find-copies-harder` (scan *all* sources, not just
  changed ones) is included.
- **Break detection (`-B`)** — split a sufficiently-dissimilar `modify` into a
  delete+add break pair before rename/copy detection, per git's break score, then let
  the halves re-pair.
- **Configurable threshold** — `renameOptions` exposes git's `-M<n>` / `-C<n>` /
  `-B<n>[/<m>]` knobs as structured options; defaults match git (rename/copy 50%,
  break per git's default).

The precise option API, the `copy` change shape, and the `-B` score semantics are
worked out in the revised design (this ADR fixes the scope decision; the revision
fixes the how) and may surface follow-up decisions captured as further ADRs.

## Consequences

- The PR carries four faithfulness matrices (renames, copies, breaks, threshold
  sweeps), each twin-pinned against real `git`.
- A new `copy` change type joins the `DiffChange` union (shape per the revised design,
  following ADR-367's two-sided + `similarity` convention).
- The facade/diff option surface grows structured rename/copy/break options; defaults
  preserve current behaviour (detection off unless requested, exactly as today).
- The design doc is revised against ADRs 366–371 before planning (scope-fold rule).
