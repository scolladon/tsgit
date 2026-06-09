# Plan — `union` merge driver (per-region content merge)

TDD per slice (Red → Green → Refactor). `npm run validate` green before every
commit. One slice = one atomic commit. Ground-truth gate: `npm run check:types`
+ `npm run validate` (harness LSP cross-root diagnostics are advisory).

## Slice 1 — per-region engine + favor-aware `mergeContent`

`feat(merge): per-region 3-way content merge with union favor`

New pure module `src/domain/merge/region-merge.ts`:

- Types: `MergeSegment = {kind:'clean'; lines} | {kind:'conflict'; ours; theirs}`.
- Move from `three-way-content.ts`: `ChangeRange`, `changesFromHunks`,
  `rangesOverlap`, `concatLines`, `lineArraysEqual`, `bytesEqual` (or import a
  shared helper). `findIdenticalTwin` folds into classification.
- `groupChanges(oursChanges, theirsChanges)` → ordered raw groups (connected
  components by span-overlap over the merged-by-`baseStart` change list; within a
  side changes never overlap, so a single-side group is exactly one change).
- `classify(group)` → `clean-ours` | `clean-theirs` | `clean-twin` | `conflict`
  (`conflict` = both sides present and not an identical twin).
- `coalesceConflicts(groups)` → merge consecutive `conflict` groups whose base
  gap (`next.start − prev.end`) **≤ 3**, absorbing any clean groups strictly
  between them into the coalesced span (constant `MAX_CONFLICT_COALESCE_GAP = 3`,
  named).
- `applyChangesToSpan(baseLines, start, end, sideChanges)` → that side's file
  content over `[start,end)` (base for untouched, replacement for changed).
- `trimCommonEdges(oursSide, theirsSide)` → `{prefix, oursMid, theirsMid, suffix}`
  (longest common leading + trailing lines by exact byte equality, prefix/suffix
  non-overlapping).
- `buildMergeSegments(baseLines, oursChanges, theirsChanges)` → ordered
  `MergeSegment[]`: walk base; emit base-run before each final group; clean
  group → `{clean, replacement}`; conflict span → `applyChangesToSpan` both
  sides, `trimCommonEdges`, emit `{clean,prefix}` + `{conflict,oursMid,theirsMid}`
  + `{clean,suffix}`; trailing base-run.

Rewrite `src/domain/merge/three-way-content.ts`:

- `MergeFavor = 'none' | 'union'`; options become
  `ConflictMarkerOptions & { favor?: MergeFavor }` (default `'none'`).
- Keep binary guard and the three `bytesEqual` fast paths.
- base `undefined` & sides differ → run the engine with an **empty** base
  (`new Uint8Array(0)`), no longer a bespoke whole-file conflict.
- `degraded` (either side) → a single **untrimmed** `{conflict, splitLines(ours),
  splitLines(theirs)}` segment (bypasses the engine; keeps `none` byte-identical
  to today's whole-file fallback).
- `renderSegments(segments, favor, options)`:
  - `none`: clean lines raw + `writeConflictMarkers(oursMid, theirsMid, options)`
    per conflict; `status:'conflict'` iff any conflict segment else `clean`.
  - `union`: flatten clean + `oursMid`++`theirsMid`; `joinLinesEnsuringInteriorLf`
    (every line but the last ends in `\n`); always `clean`.
- Export `MergeFavor` from `merge-types.ts`; barrel re-export.

Tests (RED first):

- `region-merge.test.ts` — GWT/AAA, `sut`. Cases: non-overlap → all clean
  segments; single overlap → conflict segment with trimmed mids; shared
  leading/trailing line trimmed (incl. whitespace-only); internal common kept;
  coalesce at gap 3, split at gap 4; one-sided change at gap 0 stays clean;
  add/add (empty base) trimmed; zero-length same-point inserts → conflict;
  `applyChangesToSpan` / `trimCommonEdges` unit-level.
- `three-way-content.test.ts` — extend: favor `union` resolves an overlap to
  clean bytes; default now per-region (rewrite the old whole-file expectations,
  incl. the add/add "whole-file markers" test → trimmed per-region); EOF
  no-newline union (interior `\n`, final none); degraded still whole-file for
  `none`.
- **Cross-test sweep:** the default per-region change ripples to any other
  test asserting overlap-conflict *bytes* (not just `toContain('<<<<<<<')`).
  Re-run the full suite and update each broken expectation to per-region in
  **this** slice so `validate` stays green (candidates: `merge.test.ts`,
  `merge-interop`, `merge-driver-interop`, cherry-pick/revert/rebase/stash
  integration tests with conflicting fixtures).

## Slice 2 — wire `merge=union`

`feat(merge): resolve merge=union to the union favor`

- `resolve-merge-driver.ts`: `MergeDriverChoice` gains `{kind:'union'}`;
  `namedChoice` maps `'union'` → it (replace `return TEXT`).
- `build-content-merger.ts`: `choice.kind === 'union'` →
  `mergeContent(base?.content, ours.content, theirs.content, {favor:'union'})`.
- Tests: extend `resolve-merge-driver.test.ts` (union attribute + `merge=union`
  config name → union choice) and `build-content-merger.test.ts` (union choice →
  clean union bytes on an overlapping path; text/binary/external unchanged).

## Slice 3 — interop parity

`test(interop): union driver + per-region merge parity`

- `merge-driver-interop.test.ts`: `.gitattributes` `* merge=union` →
  twin git/tsgit clean overlap, shared-edge trim, coalesced gap, add/add;
  reconstruct from structured result vs real `git merge`.
- `merge-interop.test.ts`: default per-region vs real `git merge` — non-overlap
  both-applied, single overlap trimmed, two-conflict coalesce at gap 3, separate
  at gap 4, add/add trimmed. Scrub `GIT_*`, signing off (per faithfulness
  harness conventions).

## Slice 4 — property tests

`test(merge): property tests for the region engine`

- `region-merge.properties.test.ts` + `arbitraries.ts` (base lines + two edit
  scripts, overlapping or disjoint). Properties (ADR-135 `numRuns` 100):
  1. union over non-binary input → `status:'clean'`, no conflicting line dropped.
  2. disjoint edit scripts → `union` bytes ≡ `none` bytes (both clean).

## Slice 5 — backlog refinements (bisect + archive)

`docs(backlog): refine bisect + archive scope`

Edit `docs/BACKLOG.md` Wave C:

- **24.6 `bisect`** → "expose the pure midpoint primitive only (good/bad
  reachable sets → next commit to test + remaining steps); the good/bad decision
  and the session porcelain (`start`/`good`/`bad`/`skip`/`reset`/`run`,
  `BISECT_*` state) are the consumer's, not a data-library surface."
- **24.4 `archive`** → "ship the tree→entry data stream; the tar/zip byte
  framing is a thin, separable serializer (interchange format, not display per
  ADR-249)."

## Docs (Step 9)

Update the custom-merge-drivers doc page(s) to mark `union` as supported (no
longer "falls back to text"). Flip **24.9a → `[x]`** in `docs/BACKLOG.md` (this
PR implements it); the 24.9 parent's deferred-list note for `union` is resolved.
README "merge drivers" mention if present. No new command surface, no
`api.json` change (favor is internal).
