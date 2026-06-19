# ADR-377: The rename limit counts copy sources

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)
- **Refines:** [ADR-370](370-rename-limit-skip-inexact.md), [ADR-375](375-find-copies-harder-enum.md)

## Context

ADR-370 gates the inexact pass on `num_create · num_src > limit`. With copy detection,
the source set includes copy sources (ADR-375/376). Whether those copy sources count
toward `num_src` determines when `--find-copies-harder` (which adds the whole preimage
to the source set) trips the limit. git counts them in the same product that gates the
whole inexact pass.

## Options considered

1. **(chosen) Yes — `num_src` includes copy sources** — so `--find-copies-harder` hits
   the limit far sooner. Pros: reproduces git's cost model and the pinned over-limit
   behaviour under `harder`. Cons: none material.
2. **No — copies limited by a separate cap** — Rejected: invents a non-git cap; would
   diverge on a large preimage.
3. **Copies ignore the limit entirely** — Rejected: `--find-copies-harder` on a big tree
   would never skip, diverging from git.

## Decision

The inexact-pass limit guard counts copy sources in `num_src`. The product
`num_create · num_src` (where `num_src` = rename sources + copy sources for the active
`copies` mode) is compared against the limit; over it, the **entire** inexact pass
(renames + copies) is skipped, exact pairing untouched (ADR-370). Under
`copies: 'harder'`, `num_src` spans the whole preimage, so the limit is reached far
sooner — pinned by an interop case that crosses the limit only under `harder`.

## Consequences

- `--find-copies-harder` on a large tree degrades exactly as git does (inexact skipped).
- The single limit governs the combined rename+copy matrix; no second cap to reason about.
- `limit: 0` remains "unlimited" (ADR-370) for both renames and copies.
