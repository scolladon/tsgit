# Plan — Conflict-marker size + merge-context labels

TDD per slice (Red → Green → Refactor), one atomic commit each, `npm run
validate` green before every commit. Domain (additive) → primitives (thread) →
commands (per-operation labels) → interop. Slices 1–4 are independent and
non-breaking; 5–8 thread the payloads (size becomes faithful at 7–8); 9–13 wire
each command's labels; 14 pins it against real git.

## Slice 1 — `resolveMarkerSize` (domain/attributes)

- **Red** `domain/attributes/conflict-marker-size.test.ts`: `resolveMarkerSize`
  over the strtol_i table — `'7'`→7, `'1'`→1, `'+5'`→5, `'00008'`→8, `'70'`→70,
  `'0'`→7, `'-3'`→7, `'12abc'`→7, `'0x10'`→7, `'15.9'`→7, overflow→7, and
  `true`/`false`/`'unspecified'`→7. Each clamp branch isolated (mutation:
  `> 0` boundary, the `DEFAULT` literal).
  + `conflict-marker-size.properties.test.ts`: total-function lens — for any
  `AttributeValue` arbitrary, `resolveMarkerSize` returns a positive integer and
  never throws.
- **Green** `domain/attributes/conflict-marker-size.ts`: `DEFAULT_CONFLICT_MARKER_SIZE
  = 7`; `resolveMarkerSize(value)`; `strtolI(s)` = `/^[+-]?[0-9]+$/` → `Number`,
  reject if not a 32-bit int. Export both from `domain/attributes/index.ts`.
- Commit: `feat(attributes): resolve conflict-marker-size attribute value`.

## Slice 2 — built-in markers honour the size (domain/merge)

- **Red** extend `domain/merge/conflict-markers.test.ts`: `markerSize: 1` →
  `<`/`=`/`>` each length 1 (label still appended after one space); `markerSize:
  15` → length 15; omitted → 7. All three markers scale together.
- **Green** `merge-types.ts`: `ConflictMarkerOptions` gains `markerSize?: number`.
  `conflict-markers.ts`: derive `size = options.markerSize ?? 7`; build
  `'<'.repeat(size)` / `'='.repeat(size)` / `'>'.repeat(size)`. Forbidden-substring
  label guard stays on the canonical 7-run (a hardening check, label-injection
  only — git labels never contain marker runs). `three-way-content.ts` unchanged
  (options already flow through `renderWithMarkers`).
- Commit: `feat(merge): conflict markers scale to conflict-marker-size`.

## Slice 3 — merge labels (domain/merge)

- **Red** `domain/merge/merge-labels.test.ts`: `abbreviateOid` truncates to 7;
  `replayLabels(oid, subj)` = `{HEAD, "<7> (subj)", "parent of <7> (subj)"}`;
  `revertLabels` is the inverse; `mergeLabels(rev, base)` = `{HEAD, rev,
  "<base7>"}` and `mergeLabels(rev, undefined)` = base `''`; `STASH_LABELS` exact.
- **Green** `domain/merge/merge-labels.ts`: `MergeLabels`, `abbreviateOid`,
  `commitLabel`, `replayLabels`, `revertLabels`, `mergeLabels`, `STASH_LABELS`.
  Export from `domain/merge/index.ts`.
- Commit: `feat(merge): per-operation conflict label builders`.

## Slice 4 — driver `%S`/`%X`/`%Y` placeholders (domain/attributes)

- **Red** extend `domain/attributes/driver-command.test.ts`: a template with
  `%S %X %Y` substitutes base/ours/theirs; unknown `%Z` stays literal; `%%`→`%`.
- **Green** `driver-command.ts`: `DriverPlaceholders` gains `S`/`X`/`Y`;
  `substituteOne` adds the three cases (before the default-literal branch).
- Commit: `feat(attributes): merge-driver %S/%X/%Y label placeholders`.

## Slice 5 — `resolvePathMergeSpec` (primitive)

- **Red** rework `primitives/resolve-merge-driver.test.ts`: `resolvePathMergeSpec`
  returns `{ driver, markerSize }` from one provider; `conflict-marker-size`
  attribute resolves with the same precedence as `merge`; default size 7 when
  absent; driver mapping unchanged (text/binary/union/external/driverless).
- **Green** `resolve-merge-driver.ts`: add `resolvePathMergeSpec(ctx, provider,
  path)` — one `sourcesForPath`, `resolveAttribute` for `merge` and
  `conflict-marker-size`, map via the existing choice logic + `resolveMarkerSize`.
  Keep `MergeDriverChoice` and the existing `resolveMergeDriver` (still
  build-content-merger's caller until slice 7) — no dead code yet.
- Commit: `refactor(merge): resolve driver + marker size in one pass`.

## Slice 6 — `runMergeDriver` threads size + labels

- **Red** extend `primitives/run-merge-driver.test.ts`: input `markerSize` + `labels`
  reach the command as `%L`/`%S`/`%X`/`%Y` (fake runner captures the command line).
- **Green** `run-merge-driver.ts`: `MergeDriverInput` gains `markerSize: number` +
  `labels: MergeLabels`; placeholders `{O,A,B,L:String(markerSize),P,
  S:labels.base,X:labels.ours,Y:labels.theirs}`. Drop the local
  `DEFAULT_MARKER_SIZE`.
- Commit: `feat(merge): merge driver receives marker size and labels`.

## Slice 7 — `buildContentMerger(ctx, labels?)`

- **Red** extend `primitives/build-content-merger.test.ts`: per path it resolves
  `markerSize` and threads it to the built-in merge (markers scale) and to the
  driver (`%L`); supplied `labels` reach both built-in markers and the driver
  (`%X`/`%Y`/`%S`); omitted `labels` default to `ours`/`theirs`/`''`.
- **Green** `build-content-merger.ts`: `buildContentMerger(ctx, labels?:
  MergeLabels)`; per path `resolvePathMergeSpec`; built-in →
  `mergeContent(..., { favor, markerSize, labels:{ours,theirs} })`; external →
  `runMergeDriver(..., { markerSize, labels: labels ?? DEFAULT })`. Update
  `merge.ts:306` call (still no labels → real size now). Define
  `DEFAULT_MERGE_LABELS = {ours:'ours',theirs:'theirs',base:''}` (mirrors the
  `writeConflictMarkers` default). **Remove `resolveMergeDriver`** (and its tests)
  in this same commit — `resolvePathMergeSpec` is now its only-was caller, so it
  becomes dead the instant the switch lands.
- Commit: `feat(merge): thread marker size + labels through the content merger`.

## Slice 8 — `applyMergeToWorktree` / `mergeTreesToTree` carry labels

- **Red** extend `primitives/apply-merge-to-worktree.test.ts`: a conflict with
  supplied labels writes them into the working-tree markers; absent → default.
- **Green** `apply-merge-to-worktree.ts`: `ApplyMergeInput` and
  `mergeTreesToTree`'s input gain `labels?: MergeLabels`; both pass it to
  `buildContentMerger`.
- Commit: `feat(merge): apply-merge primitives carry conflict labels`.

## Slice 9 — `merge` command labels

- **Red** extend `commands/merge.test.ts`: a content conflict's markers read
  `<<<<<<< HEAD` / `>>>>>>> <rev>`.
- **Green** `merge.ts`: build `mergeLabels(opts.rev, base)`; pass to
  `buildContentMerger`.
- Commit: `feat(merge): label conflict markers with HEAD / merged rev`.

## Slice 10 — `cherry-pick` labels

- **Red** extend `commands/cherry-pick.test.ts`: markers read `>>>>>>> <abbrev>
  (<subject>)`.
- **Green** `cherry-pick.ts` `applyOnePick`: pass `labels: replayLabels(source,
  subjectLine(cData.message))`.
- Commit: `feat(cherry-pick): label conflict markers with the picked commit`.

## Slice 11 — `revert` labels

- **Red** extend `commands/revert.test.ts`: markers read `>>>>>>> parent of
  <abbrev> (<subject>)`.
- **Green** `revert.ts` `applyOneRevert`: pass `labels: revertLabels(source,
  subjectLine(cData.message))`.
- Commit: `feat(revert): label conflict markers with the reverted commit`.

## Slice 12 — `rebase` labels (thread the source oid)

- **Red** extend `commands/rebase.test.ts`: a replay conflict's markers read
  `>>>>>>> <abbrev> (<subject>)`.
- **Green** `rebase.ts`: `mergeUnderLock` gains `source: ObjectId`; pass
  `labels: replayLabels(source, subjectLine(cData.message))` to
  `applyMergeToWorktree`; thread `source` from `replayOne` (loop has
  `rc.todo[i].oid`) and the two interactive sites (`inst.oid`).
- Commit: `feat(rebase): label conflict markers with the replayed commit`.

## Slice 13 — `stash` labels

- **Red** extend `commands/stash.test.ts`: a `stash pop` conflict's markers read
  `<<<<<<< Updated upstream` / `>>>>>>> Stashed changes`.
- **Green** `stash.ts`: pass `labels: STASH_LABELS` to `applyMergeToWorktree`
  (433) and `mergeTreesToTree` (396).
- Commit: `feat(stash): label conflict markers Updated upstream / Stashed changes`.

## Slice 14 — interop (real git)

- **Red/Green** `test/integration/conflict-marker-size-and-labels-interop.test.ts`
  (twin git/tsgit, scrubbed `GIT_*`, signing off):
  - `conflict-marker-size=15` and `=1` → built-in marker length parity (merge);
    `=0`→7, `12abc`→7.
  - a `[merge "<d>"]` driver capturing `%L %S %X %Y` → exact parity for merge
    (`HEAD` / `<branch>` / merge-base-abbrev) and cherry-pick (`<abbrev>
    (subject)` / `parent of …`).
  - built-in marker labels parity: merge `<branch>`, cherry-pick, revert, rebase,
    stash.
  - subject edge case: multi-line first paragraph → first line only.
- Commit: `test(merge): conflict-marker size + label parity with git`.

## Step 7 (architecture refactor, after reviews)

- Replace `stash.ts`'s inline `base.b.slice(0, 7)` with the shared
  `abbreviateOid` (DRY; one abbreviation policy). Behaviour-preserving.
- Consider: does `resolveMergeDriver` still have non-`resolvePathMergeSpec`
  callers? If not, fold it entirely. Re-review scoped to the refactor diff.

## Docs (Step 9)

- `README.md` (if it enumerates merge-driver placeholders / attributes),
  `docs/use/` merge-driver / gitattributes page, `RUNBOOK`/`CONTRIBUTING` if they
  mention conflict markers. Flip `docs/BACKLOG.md` 24.9b → `[x]` and fold 24.9e
  into it (mark 24.9e done / absorbed). Update the 24.9 deferred list.
