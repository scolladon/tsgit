# Design — `UnmergedEntry` worktree mode (close v2 `u`-line reconstruction)

## Goal

`status`'s `unmerged` entries already carry the per-stage `base`/`ours`/`theirs`
`{ id, mode }` blobs (stage 1/2/3) — losslessly reconstructing `git status
--porcelain=v2`'s `u`-line **stage** fields (`m1 m2 m3 h1 h2 h3`). The one v2 `u`
field they do **not** carry is `mW` — the conflicted file's **on-disk worktree
mode**. So a `u` line is the single porcelain shape that still cannot be
reconstructed from the structured `StatusResult`.

23.4h (ADR-269) finished this exact job for the ordinary changed-entry line: it
added a `worktree?: WorktreeSide` (`{ mode }`, git's `mW`, no `hW`) to
`ChangedPath`. This pass closes the symmetric gap on `UnmergedEntry`, adding the
same `worktree` endpoint so the full v2 `u` line reconstructs byte-for-byte.

Small and additive: no breaking change (a new optional field), no SHA / ref /
reflog / on-disk state / refusal change. Pure ergonomics — surface data git
already computes and `status` currently never reads for conflicted paths.

## Faithfulness anchor (git)

`git status --porcelain=v2 --no-renames` emits, per **unmerged** path:

```
u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
```

- `XY` = the two-letter unmerged code (`UU`/`AA`/`DD`/`AU`/`UA`/`DU`/`UD`) — a
  function of which stages are present, already encoded by `classifyUnmerged`.
- `sub` = `N...` for the non-submodule paths tsgit models.
- `m1` / `m2` / `m3` = octal mode in stage 1 (base) / 2 (ours) / 3 (theirs),
  `000000` when that stage is absent — carried by `base`/`ours`/`theirs`.
- **`mW` = octal mode of the conflicted file in the worktree**, `000000` when the
  file is absent on disk. **The field this pass adds.**
- `h1` / `h2` / `h3` = object name in stage 1 / 2 / 3 (all-zero when absent) —
  carried by `base`/`ours`/`theirs`. There is **no `hW`**: git never hashes the
  worktree file (it may not be in the object store), it prints only `mW`.

Verified against real `git` (signing off, scrubbed env):

```
u AA N... 000000 100644 100644 100644 0000…0000 b19a… 950b… a.txt   # both-added, present
u UU N... 100644 100644 100644 100644 df96… b19a… 950b… f.txt       # both-modified, present
u UD N... 100644 100644 000000 100644 df96… b19a… 0000…0000 g.txt   # deleted-by-them, ours on disk
# after `rm f.txt` from disk → mW flips to 000000, the stage oids are unchanged:
u UU N... 100644 100644 100644 000000 df96… b19a… 950b… f.txt
```

So `mW` is purely the **on-disk mode** (`lstat` → git mode), independent of
content; git does **no** content hash for it. Removing the file from disk flips
`mW` to `000000` while the stage blobs (`m1..m3`, `h1..h3`) stay put.

## The shape

`WorktreeSide` (mode only, no oid) and the omit-when-absent convention already
exist from ADR-269. Reuse both — `UnmergedEntry` gains one optional field,
symmetric with `ChangedPath.worktree`:

```ts
/** The working-tree side of a comparison: mode only (git's `mW`, no `hW`). */
export interface WorktreeSide {
  readonly mode: FileMode;
}

export interface UnmergedEntry {
  readonly kind: ConflictKind;
  readonly path: FilePath;
  readonly base?: BlobSide;       // stage 1 — m1 / h1
  readonly ours?: BlobSide;       // stage 2 — m2 / h2
  readonly theirs?: BlobSide;     // stage 3 — m3 / h3
  readonly worktree?: WorktreeSide; // mW — on-disk mode, omitted when absent
}
```

`worktree` is **present** whenever the conflicted file exists on disk (the common
case: `UU`/`AA` leave conflict markers, `UD`/`DU` leave the surviving side), and
**omitted** when the file is absent (`mW = 000000` — a `DD` conflict, or a path
the user removed from disk). The reconstruction maps `worktree?.mode ?? '000000'`,
exactly as it already does for `ChangedPath.worktree`.

## Algorithm

`status` already partitions the index into `grouped.staged` (stage 0) and
`grouped.unmerged` (the stage 1/2/3 groups). The conflicted paths have **no**
stage-0 entry, so they are absent from the working-tree `workingMap` pass (which
scans `grouped.staged` only). They need their own on-disk lookup.

The lookup is **mode-only** — git's `u`-line `mW` is the `lstat`-derived mode, with
no content comparison. So this does **not** reuse `compareWorkingTreeDelta` (which
takes a stage-0 `IndexEntry`, hashes content, and applies a gitlink carve-out
irrelevant here). Instead a lean local helper:

```ts
const readWorktreeMode = async (ctx, path): Promise<FileMode | undefined> => {
  const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${path}`).catch(() => undefined);
  return stat === undefined ? undefined : deriveWorkingMode(stat);
};
```

`deriveWorkingMode` is the single mode-derivation definition staging and the
working comparator already share (symlink → `120000`, exec bit → `100755`, else
`100644`), so the unmerged `mW` agrees byte-for-byte with the ordinary-line `mW`.

Wiring (mirrors the existing `workingMap` pass):

1. **Unmerged worktree pass**: `scanUnmergedWorktree(ctx, grouped.unmerged)` →
   `Map<FilePath, FileMode>`, one `readWorktreeMode` per conflicted path,
   recording only present files (`Promise.all` fan-out, like `scanWorkingTree`).
2. **Projection**: `toUnmergedEntries(grouped.unmerged, worktreeModes)` adds
   `...(mode !== undefined && { worktree: { mode } })` to each entry, keeping the
   existing byte-ordered, present-stage-only projection otherwise.

`clean` / `describe --dirty/--broken` are **unaffected** — they already count
`unmerged.length`; the new field carries no dirtiness signal of its own.

### Progress reporting

The conflicted-path `lstat`s are **not** folded into the `status:scan` granularity
tracker. That op is documented as the working-tree fan-out over stage-0 entries;
conflicted paths are a separate, typically-tiny set, and keeping them off the
tracker leaves the existing tick-count contract (and its boundary tests) untouched
(KISS). Progress is an internal concern, not a git-faithfulness surface.

## Consumers updated

- **`status.ts`** — the type, the new scan pass, the projection signature.
- **Barrel** (`commands/index.ts`) — no change: `UnmergedEntry`, `WorktreeSide`
  are already exported; only the field is added.
- **`reports/api.json`** — regenerated (the new optional property; prepush
  `check:doc-typedoc` gate).
- **`docs/use/commands/status.md`** — document the new `worktree` field on
  `UnmergedEntry` and the now-complete v2 `u`-line reconstruction.

No `describe.ts` change (its dirty check reads `changes`/`unmerged` lengths only).

## Faithful divergences (documented, not fixed here)

- **Gitlink / submodule conflicted path** — `deriveWorkingMode` cannot derive a
  `160000` gitlink, so a conflicted submodule path on disk would derive a regular
  mode. This mirrors `compareWorkingTreeDelta`'s existing, documented behaviour and
  is a pathological case (a conflicted submodule is rare and git's own `mW` for it
  is unusual); not special-cased.
- **Directory at a conflicted path** — likewise derives a regular file mode. git
  would not normally leave a directory at a conflicted blob path; not modelled.

## Testing strategy

- **Unit** (`status.test.ts`) — extend the `unmerged column` describe:
  - conflicted file **present** on disk → `worktree.mode === '100644'` (exact mode,
    not just defined — StringLiteral/mutation resistance).
  - conflicted file **absent** on disk (removed after merge) → `worktree`
    undefined, other stages intact.
  These two cover every new branch (`readWorktreeMode`'s present/absent ternary,
  `scanUnmergedWorktree`'s set-guard, `toUnmergedEntries`'s spread).
- **Interop** (`status-interop.test.ts`) — extend the v2 reconstruction to emit
  `u` lines (`u XY N... m1 m2 m3 mW h1 h2 h3 path`), interleaved with ordinary
  lines in byte-path order (git sorts the tracked section together), and add:
  - a conflict repo (UU/AA/UD/DU, all present) → byte-equal `git status
    --porcelain=v2 --no-renames`, pinning `mW = 100644`.
  - the same repo with one conflicted file removed from disk → mixed
    present/absent `mW`, pinning the `000000` path.
  This closes full v2 `u`-line reconstruction, the explicit goal.
- **Property tests** — none. This is projection/orchestration code (a map lookup
  feeding an object spread); no parse/serialize round-trip, algebraic grammar, or
  compositional matcher (the four CLAUDE.md lenses do not fit). The reconstruction
  interop is the oracle.
- **Parity / browser** — no change. The clean-repo status parity scenario carries
  no unmerged entries; cross-adapter mode derivation is already exercised by the
  ordinary-line `worktree` field (ADR-269) and `deriveWorkingMode`'s own tests.

## Non-goals / out of scope

- **No `hW`** — git never hashes the worktree file; `worktree` is mode-only,
  faithful to git's missing `hW` (ADR-269 established this for `ChangedPath`).
- **No content comparison** for `mW` — purely the `lstat`-derived mode, matching
  git's `u`-line behaviour.
- **No rename detection**, **no submodule `sub` state** — same scope boundary as
  ADR-269.

## Closes

- **23.4m** — the last v2 `u`-line field, completing porcelain-v2 reconstruction
  symmetrically with the ordinary-line endpoints 23.4h added.
