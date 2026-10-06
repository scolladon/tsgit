import type { FlatTree, FlatTreeEntry } from '../diff/flat-tree.js';
import type { FilePath } from '../objects/index.js';
import type { MergeConflict } from './merge-types.js';

/** One side's rename of a merge-base path, as git's ort pairs it. */
export interface MergeRename {
  readonly oldPath: FilePath;
  readonly newPath: FilePath;
}

/** The renames each side made from the merge base. */
export interface MergeRenames {
  readonly ours: ReadonlyArray<MergeRename>;
  readonly theirs: ReadonlyArray<MergeRename>;
}

export const NO_MERGE_RENAMES: MergeRenames = { ours: [], theirs: [] };

/** Where each side held a path a rename moved — ort's `pathnames[0..2]`. */
export interface SidePaths {
  readonly base: FilePath;
  readonly ours: FilePath;
  readonly theirs: FilePath;
}

/** The three trees with every rename's base and other-side entries moved to its new path. */
export interface RenamedMergeInput {
  readonly base: FlatTree | undefined;
  readonly ours: FlatTree | undefined;
  readonly theirs: FlatTree | undefined;
  /** Rename sources whose entries moved away, merged as deleted. */
  readonly vacated: ReadonlySet<FilePath>;
  readonly sidePaths: ReadonlyMap<FilePath, SidePaths>;
  /** Paths ort always conflicts on once renames pair them (rename/delete, rename/rename). */
  readonly forced: ReadonlyMap<FilePath, MergeConflict>;
}

type Entries = Map<FilePath, FlatTreeEntry>;

type Side = 'ours' | 'theirs';

interface Moving {
  readonly side: Side;
  readonly base: Entries;
  readonly renamingSide: Entries;
  readonly other: Entries;
  readonly otherRenames: ReadonlyMap<FilePath, FilePath>;
  readonly vacated: Set<FilePath>;
  readonly sidePaths: Map<FilePath, SidePaths>;
  readonly forced: Map<FilePath, MergeConflict>;
}

const hasRenames = (renames: MergeRenames): boolean =>
  renames.ours.length > 0 || renames.theirs.length > 0;

const byOldPath = (renames: ReadonlyArray<MergeRename>): ReadonlyMap<FilePath, FilePath> =>
  new Map(renames.map((rename) => [rename.oldPath, rename.newPath]));

const sameEntry = (a: FlatTreeEntry, b: FlatTreeEntry): boolean =>
  a.id === b.id && a.mode === b.mode;

const sideIds = (side: Side, entry: FlatTreeEntry) =>
  side === 'ours'
    ? { ourId: entry.id, ourMode: entry.mode }
    : { theirId: entry.id, theirMode: entry.mode };

const sidePathsFor = (side: Side, { oldPath, newPath }: MergeRename): SidePaths =>
  side === 'ours'
    ? { base: oldPath, ours: newPath, theirs: oldPath }
    : { base: oldPath, ours: oldPath, theirs: newPath };

const vacate = (moving: Moving, oldPath: FilePath): void => {
  moving.base.delete(oldPath);
  moving.other.delete(oldPath);
  moving.vacated.add(oldPath);
};

/** The base and the other side's edit join the renaming side's at the new path. */
const moveIntoRename = (moving: Moving, rename: MergeRename, original: FlatTreeEntry): void => {
  const kept = moving.other.get(rename.oldPath) as FlatTreeEntry;
  vacate(moving, rename.oldPath);
  moving.base.set(rename.newPath, original);
  moving.other.set(rename.newPath, kept);
  moving.sidePaths.set(rename.newPath, sidePathsFor(moving.side, rename));
};

/** ort's rename/delete: the base follows the rename, which always conflicts there. */
const renameDelete = (moving: Moving, rename: MergeRename, original: FlatTreeEntry): void => {
  vacate(moving, rename.oldPath);
  moving.base.set(rename.newPath, original);
  moving.forced.set(rename.newPath, {
    type: 'rename-delete',
    path: rename.newPath,
    baseId: original.id,
    baseMode: original.mode,
    ...sideIds(moving.side, moving.renamingSide.get(rename.newPath) as FlatTreeEntry),
  });
};

/**
 * ort's rename/add: the source's three-way result replaces the renaming
 * side's entry and meets the other side's addition as an add/add. Only a
 * result one side alone decides is taken; a content-merged one is left as is.
 */
const renameAdd = (moving: Moving, rename: MergeRename, original: FlatTreeEntry): void => {
  const kept = moving.other.get(rename.oldPath);
  const renamed = moving.renamingSide.get(rename.newPath) as FlatTreeEntry;
  if (kept === undefined) return;
  const keptUnchanged = sameEntry(kept, original);
  if (!keptUnchanged && !sameEntry(renamed, original)) return;
  vacate(moving, rename.oldPath);
  moving.renamingSide.set(rename.newPath, keptUnchanged ? renamed : kept);
};

interface Destination {
  readonly path: FilePath;
  readonly entries: Entries;
}

/**
 * ort's rename/rename(1to2): the source and both destinations each keep their
 * one stage — but a destination the opposite side also added there is left
 * to merge as that add/add, as ort's collision handling does.
 */
const renameRename = (moving: Moving, rename: MergeRename, original: FlatTreeEntry): void => {
  const otherPath = moving.otherRenames.get(rename.oldPath) as FilePath;
  const renaming = { path: rename.newPath, entries: moving.renamingSide };
  const otherSide = { path: otherPath, entries: moving.other };
  const [ours, theirs] = moving.side === 'ours' ? [renaming, otherSide] : [otherSide, renaming];
  const at = (path: FilePath, ids: object): void => {
    moving.forced.set(path, { type: 'rename-rename', path, ...ids });
  };
  const forceUnlessAdded = (side: Side, destination: Destination, opposite: Entries): void => {
    if (opposite.has(destination.path)) return;
    at(destination.path, sideIds(side, destination.entries.get(destination.path) as FlatTreeEntry));
  };
  at(rename.oldPath, { baseId: original.id, baseMode: original.mode });
  forceUnlessAdded('ours', ours, theirs.entries);
  forceUnlessAdded('theirs', theirs, ours.entries);
};

type RenameHandler = (moving: Moving, rename: MergeRename, original: FlatTreeEntry) => void;

/** ort's rename shape, by what the other side did with the source and the target. */
const handlerFor = (moving: Moving, rename: MergeRename): RenameHandler => {
  const otherTarget = moving.otherRenames.get(rename.oldPath);
  if (otherTarget === rename.newPath) return bothRenamedAlike;
  if (otherTarget !== undefined) return renameRename;
  if (moving.other.has(rename.newPath)) return renameAdd;
  if (!moving.other.has(rename.oldPath)) return renameDelete;
  return moveIntoRename;
};

const applyRename = (moving: Moving, rename: MergeRename): void => {
  const original = moving.base.get(rename.oldPath);
  if (original === undefined) return;
  handlerFor(moving, rename)(moving, rename, original);
};

/** Both sides renamed the source to the same path: only the base moves — once, as it leaves the source. */
const bothRenamedAlike = (moving: Moving, rename: MergeRename, original: FlatTreeEntry): void => {
  moving.base.delete(rename.oldPath);
  moving.vacated.add(rename.oldPath);
  moving.base.set(rename.newPath, original);
  moving.sidePaths.set(rename.newPath, {
    base: rename.oldPath,
    ours: rename.newPath,
    theirs: rename.newPath,
  });
};

/** A side whose tree was absent keeps no entry a rename could move. */
const asTree = (entries: Entries, original: FlatTree | undefined): FlatTree | undefined =>
  original === undefined ? undefined : { entries };

type Shared = Pick<Moving, 'base' | 'vacated' | 'sidePaths' | 'forced'>;

const movingFor = (
  shared: Shared,
  side: Side,
  sides: { readonly renamingSide: Entries; readonly other: Entries },
  otherRenames: ReadonlyArray<MergeRename>,
): Moving => ({ ...shared, ...sides, side, otherRenames: byOldPath(otherRenames) });

/**
 * git's ort moves each renamed path's merge-base and other-side versions to
 * the rename's destination before the per-path merge, so a file renamed on
 * one side and edited on the other merges into the new path; rename/delete
 * and rename/rename(1to2) are forced conflicts, rename/add an add/add.
 */
export function applyMergeRenames(
  base: FlatTree | undefined,
  ours: FlatTree | undefined,
  theirs: FlatTree | undefined,
  renames: MergeRenames,
): RenamedMergeInput {
  if (base === undefined || !hasRenames(renames)) {
    return { base, ours, theirs, vacated: new Set(), sidePaths: new Map(), forced: new Map() };
  }
  const ourEntries: Entries = new Map(ours?.entries);
  const theirEntries: Entries = new Map(theirs?.entries);
  const shared: Shared = {
    base: new Map(base.entries),
    vacated: new Set(),
    sidePaths: new Map(),
    forced: new Map(),
  };
  const intoOurs = { renamingSide: ourEntries, other: theirEntries };
  const intoTheirs = { renamingSide: theirEntries, other: ourEntries };
  const oursMoving = movingFor(shared, 'ours', intoOurs, renames.theirs);
  const theirsMoving = movingFor(shared, 'theirs', intoTheirs, renames.ours);
  for (const rename of renames.ours) applyRename(oursMoving, rename);
  for (const rename of renames.theirs) applyRename(theirsMoving, rename);
  const { vacated, sidePaths, forced } = shared;
  const moved = { ours: asTree(ourEntries, ours), theirs: asTree(theirEntries, theirs) };
  return { base: { entries: shared.base }, ...moved, vacated, sidePaths, forced };
}
