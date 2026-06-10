# Design — add/add content merge (empty-base content merge for both-added paths)

## Problem

When both sides of a 3-way merge **add the same path** (no entry in the merge
base), canonical git runs the **content merge against an empty base**: the
working tree receives a per-region merged file (markers only around the truly
conflicting regions, shared lines outside them), the index gets stages 2/3, and
the conflict is reported as `add/add`. With a `union` driver (or a clean
external driver) the path resolves **cleanly**. When the two sides add
**different object kinds** (file vs symlink), git instead reports
`CONFLICT (distinct types)` and renames the regular-file side to
`<path>~<label>` so each version is recorded somewhere.

tsgit's tree-level merge (`domain/merge/three-way-tree.ts` → `resolveAddAdd`)
never consults the content merger for a both-added path: differing entries
yield a bare `add-add` conflict with no `conflictContent`, and both worktree
materialisers (`merge.ts#materialiseConflictBytes`,
`apply-merge-to-worktree.ts#conflictBytes`) fall back to writing **ours**
verbatim. Stages 2/3 already match git for same-kind pairs; the working-tree
bytes, the clean-resolution cases, and the distinct-types shape do not.

The content engine is already capable: `mergeContent` handles
`base === undefined` (24.9a), and `buildContentMerger` already skips the base
blob read when `baseId` is absent. The tree-level routing and the
distinct-types rename are missing.

## Faithfulness evidence (real `git`, v2.x ort)

Probed on twin repos (scrubbed `GIT_*`, signing off, `conflictStyle=merge`);
each row is pinned by interop in this PR.

| Case (both sides add `f`) | git result |
|---|---|
| Text, shared prefix `a b` + tails `X` / `Y` | `CONFLICT (add/add)`; worktree = `a b <<<… X === Y >>>…`; stages 2/3 only |
| Text, ours `a b` ⊂ theirs `a b c` | conflict; markers wrap an **empty ours region** vs `c` |
| Identical bytes, modes 100644 vs 100755 | `CONFLICT (add/add)`; worktree = the (clean) merged content, **no markers**, ours' mode; stages 2/3 share the id, differ in mode |
| Binary, differing | `warning: Cannot merge binary files` + `CONFLICT (add/add)`; worktree keeps **ours** bytes |
| `merge=union`, differing text | **clean merge** (exit 0): ours' lines then theirs' lines, stage 0 |
| Symlink vs symlink, differing targets | `CONFLICT (add/add)`; worktree keeps **ours**' link; stages 2/3 — **no** content merge of targets |
| File vs symlink (either order) | `CONFLICT (distinct types)`; the **regular file** is renamed to `f~<side-label>`, the symlink keeps `f`; each side is a single-stage entry at its recorded path (`AU`/`UA`) |
| Distinct types, branch `feature/x` | rename suffix flattens `/` → `_`: `f~feature_x` |
| Distinct types via cherry-pick | suffix = the theirs label verbatim: `f~<abbrev> (<subject>)` |
| Distinct types, `f~side` already tracked | unique-path: `f~side_0` (`_0`, `_1`, … while occupied) |
| Distinct types, untracked file at `f~side` | merge **refuses**: `untracked working tree files would be overwritten`, nothing written |

Derived rules:

- **R1 — route through the content merger.** A both-added **regular-file**
  pair whose entries differ runs the path's resolved merge driver with
  `base = undefined` (`baseId`/`baseMode` absent from the
  `ContentMergeContext`). This reuses the whole driver stack —
  `.gitattributes` resolution, `conflict-marker-size`, labels, union favor,
  external drivers, binary detection — with zero new content-level code.
- **R2 — clean content + equal modes ⇒ resolved.** The path resolves cleanly
  (`resolved-merged` bytes, or `resolved-known` when the driver returns a
  known id). This is how `merge=union` add/add becomes a clean merge.
- **R3 — clean content + differing modes ⇒ still a conflict.** Git keeps the
  `add/add` conflict on a mode disagreement even when the content merges
  cleanly; the worktree gets the merged bytes (no markers). The conflict
  carries `conflictContent` = the clean merged bytes and
  `contentVerdict: 'clean'`.
- **R4 — conflicting content ⇒ `add-add` conflict with `conflictContent` +
  `contentVerdict`** (ADR-310). Type stays `'add-add'`; `contentVerdict` is
  `'content'` (marked bytes) or `'binary'` (take-ours bytes); the
  materialisers write `conflictContent`.
- **R5 — stage entries for same-kind pairs are unchanged.**
  `conflictStageEmissions` already emits stages 2/3 only when `baseId` is
  absent; current stage parity is preserved bit-for-bit.
- **R6 — kind routing.** Regular vs regular → content merge (R1–R4). Regular
  vs symlink → **distinct-types rename** (R7, ADR-311). Symlink vs symlink,
  or any pair involving a gitlink → today's bare `add-add` conflict (take
  ours in the worktree, no `contentVerdict`).
- **R7 — distinct-types rename** (ADR-311). New conflict type
  `'distinct-types'` with `ourPath`/`theirPath`: the regular side's recorded
  path is `<path>~<flatten(label)>` made unique against the union path set of
  the three trees plus previously generated renames (`_0`, `_1`, …); the
  symlink side keeps `path`. Labels are the operation's existing
  `MergeLabels` (ADR-307) — `mergeTrees` gains them as a parameter. Stage 2
  is emitted at `ourPath`, stage 3 at `theirPath`; the worktree gets both
  (symlink-aware write). The overwrite guard covers both recorded paths,
  reproducing git's refusal.

## Change inventory

No Tier-1 API change, no new port, no new module.

1. **`domain/merge/merge-types.ts`**
   - `ConflictType` gains `'distinct-types'`.
   - `MergeConflict` gains `contentVerdict?: 'clean' | 'content' | 'binary'`
     (ADR-310) and `ourPath?`/`theirPath?` (ADR-311, populated only on
     `distinct-types`).

2. **`domain/merge/three-way-tree.ts`**
   - `mergeTrees` gains the per-operation labels (`ours`/`theirs` strings).
   - `resolveAddAdd` routes per R6: regular pairs run the merger with a
     base-less `ContentMergeContext` and map the result per R2–R4 (oversize
     guards mirror `resolveContentMerge`); file-vs-symlink builds the
     `distinct-types` conflict via a unique-path helper; the rest keep the
     bare conflict.
   - The unique-path helper takes the union path set (already built by
     `buildUnionPaths`) plus the renames generated so far.

3. **`domain/diff/index-diff.ts` — `conflictStageEmissions`**
   - `distinct-types` emits stage 2 at `ourPath` and stage 3 at `theirPath`;
     every other type is unchanged (all stages at `conflict.path`).

4. **`application/commands/merge.ts`**
   - `materialiseConflictBytes`: `add-add` prefers `conflict.conflictContent`
     when present; ours-fallback remains for bare conflicts.
   - The conflict worktree writer handles `distinct-types`: write each side at
     its recorded path, symlink-aware (mode 120000 → `fs.symlink`, like
     `apply-changeset`'s `writeFileEntry`).
   - `mergeTrees` call sites pass the already-computed `MergeLabels`.

5. **`application/primitives/apply-merge-to-worktree.ts`**
   - `conflictBytes` first branch generalises to
     `conflictContent !== undefined`; take-ours fallback remains for bare
     conflicts. Distinct-types dual-path write as in `merge.ts`.
   - `changedPaths` includes both recorded paths of a `distinct-types`
     conflict, so the overwrite guard refuses on a dirty/untracked rename
     target (pinned).
   - The function-header equivalence notes and Stryker-disable justifications
     tied to "add-add always rewrites ours" are now **false** and must be
     re-derived or deleted (the mutants become killable).

6. **Consumers (`cherry-pick` / `revert` / `rebase` / `stash`)** inherit the
   behaviour through `applyMergeToWorktree` / `buildContentMerger` with no
   code change; their labels are already threaded (24.9b).

## Out of scope

- **Gitlink-involved add/add pairs** — bare `add-add` conflict as today
  (submodule merging is outside v1's merge surface).
- **Distinct types with a base** (type-change conflicts, base present) — the
  existing `'type-change'` conflict is untouched; git's rename behaviour there
  is a separate shape, not part of 24.9f.
- **Worktree file mode on conflict writes** (chmod of a marker file when ours
  is executable) — pre-existing behaviour, untouched.
- Display strings (`CONFLICT (add/add)`, `CONFLICT (distinct types)`,
  `Auto-merging`, binary warning) — consumer's job per ADR-249; the structured
  fields suffice to reconstruct them.

## Decisions

- **ADR-310** — conflict `type` stays `'add-add'`; the content-level verdict
  rides a new optional `contentVerdict` field.
- **ADR-311** — distinct-types rename implemented now (not deferred); scope
  regular-vs-symlink; labels reuse ADR-307's `MergeLabels`.

## Tests

- **Unit (`three-way-tree.test.ts`)** — differing both-added regular entries
  invoke the merger with `baseId === undefined`; clean+equal-modes → resolved;
  clean+mode-mismatch → `add-add` + `contentVerdict: 'clean'`; conflicting →
  `add-add` + `'content'`/`'binary'` with `conflictContent`; symlink/symlink
  and gitlink pairs bypass the merger (bare conflict, no verdict);
  file-vs-symlink builds `distinct-types` with the renamed regular side
  (both orders); unique-path `_N` probing; label flattening; oversize
  clean/marked outputs refuse with `invalidMergeInput`.
- **Unit (`index-diff.test.ts`)** — `distinct-types` stage emission at
  per-side paths.
- **Unit (materialisers)** — `materialiseConflictBytes` / `conflictBytes`
  prefer `conflictContent` for `add-add`, fall back to ours without it;
  distinct-types writes both paths, symlink via `fs.symlink`.
- **Interop (`add-add-content-interop.test.ts`)** — twin git/tsgit repos, one
  case per evidence row: text per-region markers + stages, empty-ours region,
  mode-only conflict, binary take-ours, union clean, symlink/symlink
  take-ours, distinct-types both orders (worktree + single-stage entries at
  recorded paths), slashed-branch flattening, tracked `~` collision (`_0`),
  untracked-target refusal parity. Working tree compared byte-for-byte;
  stages via `lsStage`.
- **Existing suites** — `merge-conflict-interop` (modify/modify) and
  `merge-driver-interop` must stay green (no behaviour change for based
  paths).

## Risks

- The `apply-merge-to-worktree` equivalence-comment re-derivation must be done
  carefully: stale "equivalent" claims would hide real mutants.
- `resolveAddAdd` becoming async is absorbed by `resolvePath`'s existing
  `Promise` handling; no caller change.
- The distinct-types dual-path conflict is the first conflict whose stage
  entries span two paths — the `conflictsToIndexEntries` duplicate-path check
  must treat the recorded paths (not `conflict.path`) as the uniqueness keys.
