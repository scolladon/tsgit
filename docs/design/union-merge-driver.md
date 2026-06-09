# Design — `union` built-in merge driver (per-region content merge)

## Problem

Two faithfulness gaps share one root cause:

1. **`merge=union` is unimplemented.** `resolveMergeDriver` maps the `union`
   attribute value to the built-in **text** driver (`resolve-merge-driver.ts`:
   `if (name === 'union') return TEXT`). Git's `union` driver
   (`XDL_MERGE_FAVOR_UNION`) resolves an overlapping change by concatenating
   both sides' lines with **no** conflict markers; tsgit silently produces a
   normal text conflict instead.

2. **The default content merge diverges from git on any overlap.**
   `mergeContent` computes per-side change ranges, and when two changes overlap
   (`mergePlans` returns `undefined`) it bails to a **whole-file** conflict —
   the entire `ours` wrapped against the entire `theirs`. Canonical git emits a
   **per-region** conflict: only the overlapping span is marked, the
   non-overlapping edits from each side are applied cleanly.

Both are the same missing capability: a **per-region 3-way merge** that walks
the two edit scripts in lockstep and produces an ordered list of merge
*segments* (clean runs interleaved with conflict regions). The `union` driver is
then one *favor* mode over that segment list. The backlog item (24.9a) scopes
union, noting it "needs the per-region merge rework … rather than shipping a
known-divergent approximation" — this design is that rework.

## Faithfulness evidence (real `git merge-file`)

Probed against system git; every rule below is pinned by interop in this PR.

| Case | base → ours / theirs | git default | git `--union` |
|------|---------------------|-------------|---------------|
| Non-overlapping edits on both sides | clean per-region | applies both | applies both |
| Overlapping edit | conflict on **only** the overlap | markers around overlap | ours-mid ++ theirs-mid |
| Conflict sides share a **trailing** line `Z` | `Z` pulled out below the conflict | — | `… ours … theirs … Z` |
| Conflict sides share a **leading** line `P` | `P` pulled out above the conflict | — | `P … ours … theirs …` |
| Whitespace-only shared edge line | still trimmed (no alnum gate) | — | — |
| Internal shared line (`A MID B` / `C MID D`) | **not** split — `MID` stays inside | one block | `A MID B C MID D` |
| Two conflicts, gap of **≤3** common lines | **coalesced** into one block (gap dup'd inside both sides) | one block | gap appears in both sides |
| Two conflicts, gap of **≥4** common lines | **separate** blocks | two blocks | gap appears once |
| Add/add (empty base), `a b c` / `a X c` | per-region, trimmed → `a <<<b===X>>> c` | — | — |
| EOF without trailing newline, union | — | — | interior line gets `\n`, final line keeps no-`\n` |

Derived rules:

- **R1 — region construction.** From the two per-side change lists (against the
  base), a *conflict region* forms wherever an `ours` change and a `theirs`
  change overlap in the base (existing `rangesOverlap`, incl. zero-length
  inserts at the same offset). Identical twins resolve clean (already handled).
- **R2 — coalescing.** Two **conflict** regions separated by **≤ 3** base lines
  coalesce into one region spanning both; the in-between lines become part of
  both the `ours` side and the `theirs` side (each side = that side's file
  content over the coalesced base span). Fixed constant, independent of conflict
  size (verified over a size×gap matrix). Coalescing is **conflict↔conflict
  only**: a one-sided (clean) change adjacent to a conflict is never absorbed,
  even at gap 0 (verified) — it is applied as its own clean segment. A one-sided
  change *inside* a coalescing gap is swept into the span by the
  content-over-span rule; that nested case is pinned by interop.
- **R3 — zealous edge trim.** Within a conflict region (after coalescing), the
  longest common **prefix** and **suffix** lines (exact byte equality) of the
  assembled `ours`-side and `theirs`-side are emitted as clean runs outside the
  conflict; internal common lines stay inside. No alphanumeric gating. Trimming
  lives entirely in `buildMergeSegments`, so the binary/`degraded` fallback —
  which bypasses segment construction with a single untrimmed conflict — keeps
  the default (`none`) output **byte-identical to today**.
- **R4 — favor render.** `none` → `writeConflictMarkers(oursMid, theirsMid)` per
  region. `union` → `oursMid` lines then `theirsMid` lines, no markers.
- **R5 — newline safety.** When concatenating line groups (union), every line
  except the final one ends in `\n`; a missing trailing newline survives only on
  the file's true last line.

## Scope decision (ADR — Option A vs B)

The per-region engine is required for union regardless. The open choice is what
to do with the **default** (markers) path:

- **Option A — full per-region engine (recommended).** Render conflict regions
  as per-region markers for the default favor too, retiring the whole-file
  fallback. Fixes gap #2 (a proven, un-ADR'd divergence), unifies add/add and
  the overlap path onto one engine, and ships union as a favor. One code path.
- **Option B — union-only.** Keep the whole-file fallback for the default favor;
  use the new engine *only* for union's clean resolution. Smaller diff to the
  default conflict surface; leaves gap #2 as a separate future item and carries
  two divergent content-merge paths.

The prime directive ("replicate git byte-for-byte unless an ADR diverges")
makes **A** the default: the whole-file fallback is an un-sanctioned divergence,
and the engine that fixes it is being built anyway. **A** is recommended and
assumed below; the ADR records the decision. (If B is chosen, the engine still
lands but `mergeContent`'s default branch keeps `wholeFileConflict`, and a new
backlog item captures the default per-region fix.)

## Architecture

Hexagonal placement: the merge is **pure domain** (`domain/merge/`), no platform
deps. The driver *selection* (attributes + config) stays in the application
primitives.

### New — `domain/merge/region-merge.ts` (pure, internal)

```
type MergeSegment =
  | { readonly kind: 'clean'; readonly lines: ReadonlyArray<Uint8Array> }
  | { readonly kind: 'conflict';
      readonly ours: ReadonlyArray<Uint8Array>;
      readonly theirs: ReadonlyArray<Uint8Array> }

// base/ours/theirs already split into lines; base may be empty (add/add).
buildMergeSegments(
  baseLines, oursLines, theirsLines,
  oursChanges, theirsChanges,           // ChangeRange[] from changesFromHunks
): ReadonlyArray<MergeSegment>
```

Responsibilities, in order: interleave the two change lists over the base into
raw regions (clean / single-side / conflict); **coalesce** conflict regions per
R2; for each conflict region compute the `ours`-side and `theirs`-side line
content over its base span (apply that side's changes, keep base for untouched
lines); **trim** common prefix/suffix per R3 into surrounding clean runs.
`ChangeRange`, `rangesOverlap`, and `findIdenticalTwin` move here from
`three-way-content.ts` (shared, deduplicated).

### Rewritten — `domain/merge/three-way-content.ts`

`mergeContent(base, ours, theirs, options)` becomes the favor-aware orchestrator:

- binary guard → unchanged (take ours, binary conflict; favor inapplicable).
- fast paths (`ours==theirs`, `ours==base`, `theirs==base`) → unchanged.
- otherwise: `diffLines` both sides; on `degraded`, model the whole file as a
  single conflict region (one `{kind:'conflict', ours:allOurs, theirs:allTheirs}`
  segment) so it still renders per favor (documented internal fallback — git has
  no such cap). Else `buildMergeSegments`, then `renderSegments(segments, favor,
  options)`:
  - `none`: clean runs raw + `writeConflictMarkers` per conflict; status
    `conflict` iff any conflict segment, else `clean`.
  - `union`: flatten clean + `ours`++`theirs` per conflict; `joinLines` with
    interior-`\n` safety (R5); always `clean`.

`options` gains `favor?: 'none' | 'union'` (default `'none'`). `MergeFavor`
exported from `merge-types.ts`.

### `resolve-merge-driver.ts`

`MergeDriverChoice` gains `{ kind: 'union' }`; `namedChoice` maps `union` to it
(replacing the `return TEXT` deferral). The `union` value can also come straight
from a `merge=union` attribute.

### `build-content-merger.ts`

`choice.kind === 'union'` → `mergeContent(base, ours, theirs, { favor: 'union' })`.
`text` / `external` / `binary` unchanged.

No change to `merge.ts`, `apply-merge-to-worktree.ts`, `three-way-tree.ts`,
`mergeTrees`, or any Tier-1 command surface: favor is resolved inside the
existing `ContentMerger`, so every 3-way consumer (merge / cherry-pick / revert
/ rebase / stash) inherits union for free via `.gitattributes`.

## Tests

- **Unit — `region-merge.test.ts`**: R1–R3 in isolation (overlap, coalesce
  boundary at gap 3 vs 4, prefix/suffix trim incl. whitespace-only, internal
  common kept, add/add empty base). GWT/AAA, `sut`, 100% coverage, 0 killable
  mutants.
- **Unit — `three-way-content.test.ts`**: extend for favor `union` (clean
  resolution of an overlap) and the per-region default markers; update the
  existing whole-file expectations to per-region (they pinned the divergence).
- **Property — `region-merge.properties.test.ts`**: the engine is a total
  function + compositional aggregator over a line grammar (lenses 3 & 2). Two
  robust invariants (no production-loop re-implementation):
  1. **Totality / union resolves** — for any non-binary `base`/`ours`/`theirs`
     derived from random edit scripts, `mergeContent(..., {favor:'union'})`
     returns `status:'clean'` and a non-shrinking byte length (≥ each side's
     conflicting content is preserved, never dropped).
  2. **Disjoint-edit equivalence** — when the two edit scripts touch
     non-overlapping base ranges, `union` and `none` produce the **same** clean
     bytes (both just apply the two changesets); no conflict arises either way.
  Shared `arbitraries.ts` (base lines + two disjoint/overlapping edit scripts).
  Tiered `numRuns` per ADR-135 (100 default).
- **Interop — `merge-driver-interop.test.ts`**: add `merge=union` cases (clean
  overlap, shared-edge trim, coalesced gap, add/add) reconstructing
  `git merge-file --union` / a real `git merge` with a `union` attribute.
- **Interop — `merge-interop.test.ts`**: add default per-region cases
  (non-overlap both-applied, single overlap trimmed, two-conflict coalesce at
  gap 3, separate at gap 4, add/add trimmed) vs real `git merge`.

## Backlog refinements (folded into this PR)

Per the user's request, two Wave-C entries are refined in `docs/BACKLOG.md`
alongside this work (docs-only, no code):

- **24.6 `bisect`** — reframed: expose only the **pure midpoint primitive**
  (`good`/`bad` reachable sets → next commit to test + remaining steps); the
  good/bad decision and the stateful session porcelain (`start`/`good`/`bad`/
  `skip`/`reset`/`run`, `BISECT_*` state files) are the consumer's, not a
  data-library surface.
- **24.4 `archive`** — reframed: ship the tree→entry **data stream** as the
  library surface; the tar/zip byte framing is a thin, isolated serializer
  (interchange format, not display per ADR-249), kept separable.

## Non-goals (unchanged deferrals)

the `ours`/`theirs` strategy favors (git's `-X` merge-strategy option, not
driver attributes),
diff3 conflict style, `conflict-marker-size`/labels (24.9b), and `recursive`
driver selection (24.9d). Binary content under `union` stays a take-ours
conflict (line union is undefined for binary).
```
