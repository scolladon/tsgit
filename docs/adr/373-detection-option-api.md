# ADR-373: Detection knobs extend `RenameDetectOptions` as one cohesive object

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)
- **Refines:** [ADR-369](369-copy-break-threshold-scope.md)

## Context

ADR-369 ships configurable threshold, copy detection, and break detection. These need a
public option surface, threaded through `DiffTreesOptions.renameOptions` (which already
carries `RenameDetectOptions`) and exposed on the facade (`DiffOptions`,
`RepositoryConfig`). The shape of that surface is a load-bearing API choice.

## Options considered

1. **(chosen) Extend `RenameDetectOptions`** — add `threshold`,
   `copies: 'off'|'on'|'harder'`, `copyThreshold`, and
   `breakRewrites: { score, merge } | false`. Pros: one cohesive object already threaded
   through `diffTrees` (no new `DiffTreesOptions` key); names read as intent;
   `breakRewrites` captures git's two-number `-B<n>/<m>` natively. Cons: one object
   spans three diffcore passes (acceptable — they are one detection concern).
2. **Separate `findRenames` / `findCopies` / `breakRewrites` objects on
   `DiffTreesOptions`** — Rejected: fragments a single diffcore concern across three new
   keys.
3. **Flat `diffcoreOptions` bag with git-letter keys (`M`, `C`, `B`)** — Rejected:
   leaks git's terse flag letters into the public type (against the ADR-249 intent).

## Decision

`RenameDetectOptions` grows: `threshold?` (rename `minimum_score`, `0..MAX_SCORE`,
default 30000), `copies?: 'off'|'on'|'harder'` (default `'off'`), `copyThreshold?`
(default = `threshold`), and `breakRewrites?: { score: number; merge: number } | false`
(default `false`; `score` = `<n>` break-attempt gate default 30000, `merge` = `<m>`
keep-broken gate default 36000, a `merge` of 0 maps to the 36000 default). `DiffOptions`
and `RepositoryConfig` gain a `renameOptions?: RenameDetectOptions` pass-through.
Defaults preserve today's behaviour (detection off unless requested).

## Consequences

- No new `DiffTreesOptions` key; the existing `renameOptions` channel carries everything.
- The data layer takes a numeric `threshold` in `0..MAX_SCORE`; git's textual forms
  (`-M50%`, `-M50`, `-M0.5`) are parsed to a score by the caller / a thin helper, never
  inside the data layer (ADR-249).
- `--find-copies-harder` is the `copies: 'harder'` enum value (ADR-375).
