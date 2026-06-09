# ADR-305: `union` merge driver lands a full per-region content merge, retiring the whole-file fallback

## Status

Accepted (at `eac30e58`)

## Context

The `union` built-in merge driver (`XDL_MERGE_FAVOR_UNION`) resolves an
overlapping change by concatenating both sides' lines with no conflict markers.
tsgit's content merge (`domain/merge/three-way-content.ts`) cannot express this:
when two changes overlap it discards the per-side edit information and bails to a
**whole-file** conflict (`mergePlans` → `undefined` → `wholeFileConflict`). So
`merge=union` is wired to fall back to the built-in **text** driver
(`resolve-merge-driver.ts`).

Verifying against real `git merge-file` showed the whole-file fallback is itself
a divergence on the **default** (non-union) path: git emits **per-region**
conflict markers — only the overlapping span is marked, the non-overlapping
edits from each side apply cleanly — and applies zealous refinements
(prefix/suffix trim of the conflict's two sides; coalescing of conflict regions
separated by ≤3 lines). The same is true for add/add (empty base): git trims to
the differing span, tsgit wraps the whole file.

Building union requires a per-region engine regardless. The decision is whether
that engine **also** replaces the default whole-file fallback, or whether the
default path keeps diverging while only union uses the engine.

- **Option A** — the engine renders conflict regions per-region for the default
  favor too; the whole-file fallback is retired. One code path; fixes the
  default divergence; add/add becomes per-region/trimmed.
- **Option B** — the engine is used only for union's clean resolution; the
  default favor keeps `wholeFileConflict`. Two content-merge code paths; the
  default divergence is deferred to a new backlog item.

The prime directive (ADR-226) mandates byte-for-byte faithfulness on on-disk
state — and a conflicted working-tree file's marker bytes are on-disk state —
"unless an ADR explicitly diverges and says why". The whole-file fallback is an
un-sanctioned divergence; its in-code comment already records it as "deferred to
a future iteration". 24.9a is that iteration.

## Decision

**Option A.** The per-region merge engine (`domain/merge/region-merge.ts`)
becomes the single content-merge path, parameterised by a favor mode:

- `none` (default) → per-region conflict markers (`writeConflictMarkers` per
  region), retiring `wholeFileConflict` for the overlap and add/add paths.
- `union` → the conflict region's `ours`-middle then `theirs`-middle, no
  markers (always clean).

It faithfully reproduces git's region construction, conflict↔conflict coalescing
(≤3-line gap), and zealous prefix/suffix trimming. The binary and `degraded`
guards bypass segment construction with a single untrimmed conflict region, so
their default output stays byte-identical to today. The change is localised to
`domain/merge/` plus the driver-choice wiring (`resolve-merge-driver`,
`build-content-merger`); no Tier-1 command surface changes, and every 3-way
consumer (merge / cherry-pick / revert / rebase / stash) inherits union via
`.gitattributes` for free.

## Consequences

### Positive

- One faithful content-merge path; the default overlap and add/add outputs now
  match canonical git byte-for-byte (closes an un-ADR'd divergence).
- `merge=union` works for real, pinned against `git merge-file --union` and a
  real `git merge` with a `union` attribute.
- No second/parallel merge code path; DRY, and mutation/interop coverage applies
  to the one engine.

### Negative

- Behaviour change on the heavily interop- and mutation-pinned default conflict
  surface: existing whole-file expectations are rewritten to per-region, and the
  new coalescing/trimming logic widens the byte-exactness blast radius. Mitigated
  by extending `merge-interop` with default per-region goldens and the
  size×gap-boundary cases.

### Neutral

- Favor stays minimal: `none` and `union` only. `-Xours`/`-Xtheirs`, diff3,
  `conflict-marker-size`/labels (24.9b), and recursive driver selection remain
  out of scope.
- The nested case of a one-sided change falling inside a coalescing gap is
  resolved by the content-over-span rule and pinned by interop rather than by a
  separate construction rule.
