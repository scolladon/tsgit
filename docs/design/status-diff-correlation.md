# Design — status↔diff correlation (self-describing status changes)

## Goal

A read-model **ergonomics** pass, surfaced by the 23.4 API review (finding
**M3**). `status` and `diff` return unrelated shapes, so a consumer that wants
"for this changed path, give me the staged change, the unstaged change, and the
actual hunks" must re-derive the tree/index/working-tree state by hand.

Today `status` discards the very data that would link a change to its hunks:

```ts
export interface ChangeEntry {
  readonly kind: ChangeKind;   // 'modified' | 'added' | …
  readonly path: FilePath;     // …and nothing else
}
```

The staged column literally computes a full `DiffChange` (with `oldId`/`newId`/
`oldMode`/`newMode`) via `diffIndexAgainstTree`, then throws everything but
`kind`/`path` away. The working column hashes the working file inside
`compareWorkingTreeEntry`, then collapses the result to a coarse enum. So a
caller holding a `ChangeEntry` cannot read the blobs that form the diff without
re-resolving HEAD's tree, the index, and the working file from scratch.

23.2c (ADR-256) already made the **unmerged** column self-describing — each
`UnmergedEntry` carries its per-stage `base`/`ours`/`theirs` `{ id, mode }`
blobs, lossless against `git status --porcelain=v2`'s `u` line. **23.4h finishes
the job for the staged and working-tree columns:** every changed path becomes a
self-describing diff input carrying its `head`/`index`/`worktree` endpoints,
mirroring porcelain v2's ordinary changed-entry line.

This is an **ergonomics + correlation** pass, not new git behaviour: no SHA, ref,
reflog, on-disk state, or refusal changes. It restructures the public
`StatusResult` shape (breaking — allowed in the 23.4 window, ADR-260's
no-release-bundling note) and stops discarding data already in hand.

## Faithfulness anchor (git)

`git status --porcelain=v2 --no-renames` emits, per **ordinary** changed path:

```
1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
```

- `X` = staged status (index vs HEAD); `Y` = unstaged status (worktree vs index);
  `.` when that side is unchanged.
- `mH` / `mI` / `mW` = octal file mode in HEAD / index / worktree (`000000` when
  that side is absent).
- `hH` / `hI` = object name in HEAD / index (all-zero when absent). The worktree
  blob is **not** hashed by git (the file may not be in the object store), so
  there is no `hW` — git prints only `mW`.
- Untracked paths are a separate `? <path>` line (no mode, no oid).
- Unmerged paths are a separate `u` line (out of scope here — owned by ADR-256).

`ChangedPath` is the structured form of that ordinary line: `staged`/`unstaged`
are the X/Y kinds; `head`/`index` carry `{ id, mode }`; `worktree` carries
`{ mode }` only (no oid — faithful to git's missing `hW`). The library renders no
status string; the interop test reconstructs both `--porcelain` (v1) and
`--porcelain=v2` from the structured fields and asserts byte-equality with real
`git` (ADR-249 — structured output, not cosmetics).

## Decisions (ADR-269)

Two load-bearing choices, settled with the user:

1. **One correlated record per path** (porcelain v2 model), not enriched
   two-columns. `StatusResult.changes: ReadonlyArray<ChangedPath>` replaces the
   separate `indexChanges` / `workingTreeChanges` arrays. The staged and unstaged
   states for a path live on **one** record — directly closing M3's
   "staged vs unstaged" cross-column stitch — and the endpoints make the hunks
   one `readBlob` away. `unmerged` stays a separate field (git models conflicts
   as a distinct category; ADR-256), and **untracked** becomes its own
   `untracked: ReadonlyArray<FilePath>` field (git's separate `?` lines; keeps a
   path that is both staged-deleted and on-disk — `rm --cached` — as two clean
   sources instead of one overloaded record).

2. **Endpoints only**, no `withHunks` selector. `status` surfaces the oids/modes;
   the caller materialises a `LineDiff` with one `readBlob` + `diffLines` (staged)
   or `readBlob` + read-working-file-by-path (unstaged). This keeps `status` —
   a hot command — free of folded-in Myers passes, and stays faithful to porcelain
   v2 (which carries oids, not hunks). A `withHunks` selector remains addable
   additively later if a real consumer needs it.

Rejected: enriching the two existing columns (leaves the staged↔unstaged join to
the consumer; less faithful to v2's one-line-per-path model); a separate
correlation command (the backlog directs the richness onto `status`); a
`withHunks` selector now (YAGNI — no consumer yet, and the worktree-not-in-store
asymmetry makes eager materialisation the heavier path).

## The shape

```ts
/** A blob reference on one side of a comparison: its object id and file mode. */
export interface BlobSide {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

/** The working-tree side: mode only — the file is not in the object store, so
 *  git prints `mW` but no `hW`. */
export interface WorktreeSide {
  readonly mode: FileMode;
}

export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'type-changed'
  | 'mode-changed';
  // 'untracked' removed — untracked paths move to their own field.

/**
 * One tracked path with a staged and/or unstaged change — the structured form of
 * `git status --porcelain=v2`'s ordinary changed-entry line. At least one of
 * `staged` / `unstaged` is present. The `head`/`index`/`worktree` sides carry the
 * blobs that form the change's diffs; an absent side means the path does not exist
 * on that side (staged add → no `head`; staged delete → no `index`; deleted in
 * worktree → no `worktree`).
 */
export interface ChangedPath {
  readonly path: FilePath;
  readonly staged?: ChangeKind;     // X — index vs HEAD
  readonly unstaged?: ChangeKind;   // Y — worktree vs index
  readonly head?: BlobSide;         // hH / mH
  readonly index?: BlobSide;        // hI / mI
  readonly worktree?: WorktreeSide; // mW (no hash)
}

export interface UnmergedEntry {
  readonly kind: ConflictKind;
  readonly path: FilePath;
  readonly base?: BlobSide;   // was ConflictStage — same shape, now shared
  readonly ours?: BlobSide;
  readonly theirs?: BlobSide;
}

export interface StatusResult {
  readonly branch: RefName | undefined;
  readonly detached: boolean;
  readonly changes: ReadonlyArray<ChangedPath>;
  readonly untracked: ReadonlyArray<FilePath>;
  readonly unmerged: ReadonlyArray<UnmergedEntry>;
  readonly clean: boolean;
}
```

`ConflictStage` is renamed to **`BlobSide`** and reused for `head`/`index` and
`base`/`ours`/`theirs` — one `{ id, mode }` endpoint type across the whole
status surface (DRY; the rename is the feature's own concern, not a speculative
abstraction). `BlobSide` is structurally identical to the domain `FlatTreeEntry`,
so HEAD-side population is a direct field copy.

## Algorithm

`status` already runs three passes; the change is to **stop discarding** what they
compute and **merge** the staged and working passes into per-path records.

1. `headTree = readHeadTree(ctx)` — HEAD's `FlatTree` (`path → { id, mode }`), or
   `undefined` for an unborn HEAD. Already read for the staged diff; now also the
   source of every record's `head` side.
2. `grouped = groupUnmergedEntries(index)`; build `stage0Map: Map<path,
   IndexEntry>` from `grouped.staged` — the source of every record's `index` side.
3. **Working pass** (pass 1): for each stage-0 entry, `compareWorkingTreeDelta`
   → `{ status, worktreeMode? }` (the enriched comparator — see below). Build
   `workingMap: Map<path, { status, worktreeMode? }>` for **all** stage-0 entries
   (not only changed ones), so a staged-only path still gets its `worktree` mode.
   Skip-worktree entries are skipped (unchanged behaviour).
4. **Staged pass**: `diffIndexAgainstTree(index, headTree).changes`, minus
   unmerged paths (unchanged filter), projected to `stagedKindMap: Map<path,
   ChangeKind>` via `toStagedKind`.
5. **Untracked pass** (pass 2): `walkWorkingTree` (gitignore-filtered) → paths not
   in the tracked set (stage-0 ∪ unmerged) → `untracked: FilePath[]`, sorted by
   `comparePaths`.
6. **Merge**: the change set is `stagedKindMap.keys()` ∪ { paths whose
   `workingMap` status is a change (≠ `unchanged`) }. For each path build a
   `ChangedPath`:
   - `staged` = `stagedKindMap.get(path)`.
   - `unstaged` = `toUnstagedKind(workingMap.get(path)?.status)` (`unchanged`/
     absent → `undefined`; `absent` → `'deleted'`).
   - `head` = `headTree?.entries.get(path)` → `{ id, mode }` or omitted.
   - `index` = `stage0Map.get(path)` → `{ id, mode }` or omitted.
   - `worktree` = `workingMap.get(path)?.worktreeMode` → `{ mode }` or omitted.
   - Sort by `comparePaths`.
7. `clean` = `changes`, `untracked`, **and** `unmerged` all empty.

Every side reflects existence, independent of which axis flagged the change — so a
record reconstructs a porcelain v2 ordinary line directly. When `staged`
is `undefined` the `head` side equals the `index` side (git prints `hH == hI`);
populating `head` from `headTree` regardless keeps the record direct rather than
forcing the consumer to infer equality.

### Worktree-side comparator enrichment

`compareWorkingTreeEntry` collapses its result to a `WorkingTreeComparison` enum
and discards the working mode it derived. It is consumed by **five** sites — four
(`rm`, `stash`, `clean-work-tree`, `apply-merge-to-worktree`) need only the enum.
To surface `mW` to `status` without a second `lstat` and without churning the four
enum consumers, split into:

```ts
export interface WorkingTreeDelta {
  readonly status: WorkingTreeComparison;
  readonly worktreeMode?: FileMode;   // omitted only when status === 'absent'
}

export const compareWorkingTreeDelta =
  (ctx, entry) => Promise<WorkingTreeDelta>;          // the full logic

export const compareWorkingTreeEntry =
  async (ctx, entry) => (await compareWorkingTreeDelta(ctx, entry)).status;  // projection
```

The enum function becomes a one-line projection over the richer core (no
duplicated logic, DRY); the four enum consumers are untouched; `status` uses
`compareWorkingTreeDelta`. `compareWorkingTreeEntry` is an internal application
primitive (not a blessed `repo.primitives.*` surface), so this is invisible to
the public primitive barrel.

## Consumers updated

- **`describe --dirty/--broken`** (`describe.ts`) — the only src consumer of the
  `StatusResult` shape. Its three-way dirty check
  (`indexChanges.length > 0 || workingTreeChanges.some(kind !== 'untracked') ||
  unmerged.length > 0`) **simplifies** to `changes.length > 0 || unmerged.length >
  0`: every `ChangedPath` is a tracked staged/unstaged change (untracked is now a
  separate field, which `--dirty` ignores — unchanged behaviour). Behaviour-
  preserving: same dirtiness verdict on every input.
- **Barrel** (`commands/index.ts`) — drop `ChangeEntry` and `ConflictStage`; add
  `ChangedPath`, `BlobSide`, `WorktreeSide`. `ChangeKind`, `ConflictKind`,
  `UnmergedEntry`, `StatusResult`, `status` stay.
- **`reports/api.json`** — regenerated (new/removed public types; prepush
  `check:doc-typedoc` gate).

## Testing strategy

- **Unit** (`status.test.ts`, rewritten to the new shape) — per-path records for:
  staged-only (add/modify/delete/type/mode), unstaged-only (modify/delete/type/
  mode), both columns on one path (`MM`, `AM`, `MD`), `rm --cached` (staged delete
  in `changes` + path in `untracked`), unborn HEAD (all-added, no `head`), clean
  tree, conflicted index (paths only under `unmerged`, absent from `changes`).
  Assert the endpoints (`head`/`index`/`worktree` ids+modes), not only the kinds —
  StringLiteral/mutation resistance per CLAUDE.md.
- **Comparator unit** (`compare-working-tree-entry.test.ts`) — extend with
  `compareWorkingTreeDelta` cases asserting `worktreeMode` for each status
  (`modified`/`type-changed`/`mode-changed`/`unchanged` present; `absent` omitted),
  plus the enum projection still returns the bare status.
- **Interop** (`status-interop.test.ts`) — keep the `--porcelain` (v1)
  reconstruction (now from `changes`/`untracked`/`unmerged`); **add** a
  `--porcelain=v2 --no-renames` reconstruction of the ordinary `1` lines +
  untracked `?` lines from the endpoints (`mH mI mW hH hI`), asserting byte-equal
  with real `git` across the non-conflict scenarios. This pins the new endpoints
  byte-for-byte. The conflict scenario stays v1 (unmerged `u`-line carries an `mW`
  this PR does not add to `UnmergedEntry` — out of scope, logged below).
- **Parity** (`init-add-commit-status.scenario.ts`) and **browser**
  (`opfs-roundtrip.spec.ts`) — updated mechanically to the new field names.
- **Property tests** — none. This is projection/orchestration code merging two
  maps into records; it has no parse/serialize round-trip, algebraic grammar, or
  compositional matcher (the four CLAUDE.md lenses do not fit). The
  reconstruction interop is the oracle.

## Non-goals / out of scope

- **No `withHunks`** — endpoints only (ADR-269 decision 2).
- **No rename detection** — `status` stays `--no-renames`-faithful (the staged
  diff never emits renames; the working pass is per-entry). No porcelain v2 `2`
  rename lines.
- **No submodule state** in records — the `sub` field of git's `1`/`2` lines is
  always `N...` for the non-submodule paths tsgit's status models; not surfaced.
- **`unmerged` unchanged** — already self-describing (ADR-256). Adding the
  conflict-path **worktree mode** (`mW` of the `u` line) so `UnmergedEntry` can
  reconstruct the full v2 `u` line is a logged follow-up (**23.4m**), not this PR.
- **Read-model convergence** (commands as projections over a unified read model)
  remains the 23.4j capstone; this pass defines the v2-faithful `StatusResult`
  shape that capstone will converge on, without forcing the abstraction early.

## Backlog follow-up

- **23.4m** — `UnmergedEntry` worktree mode, closing full porcelain-v2 `u`-line
  reconstruction (surfaced here; `mW` is the one v2 `u` field not yet carried).
