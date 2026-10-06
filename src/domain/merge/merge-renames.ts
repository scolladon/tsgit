import type { FlatTree, FlatTreeEntry } from '../diff/flat-tree.js';
import type { FilePath } from '../objects/index.js';

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
}

type Entries = Map<FilePath, FlatTreeEntry>;

interface Moving {
  readonly base: Entries;
  readonly other: Entries;
  readonly otherSources: ReadonlySet<FilePath>;
  readonly vacated: Set<FilePath>;
  readonly sidePaths: Map<FilePath, SidePaths>;
}

const hasRenames = (renames: MergeRenames): boolean =>
  renames.ours.length > 0 || renames.theirs.length > 0;

const sourcesOf = (renames: ReadonlyArray<MergeRename>): ReadonlySet<FilePath> =>
  new Set(renames.map((rename) => rename.oldPath));

/**
 * A rename the other side kept the source of: the base entry and the other
 * side's edit join the renaming side's at the new path, so the three-way merge runs
 * there. Rename/delete, rename/add and rename/rename keep their own shapes.
 */
const moveRename = (
  rename: MergeRename,
  moving: Moving,
  sidePathsOf: (rename: MergeRename) => SidePaths,
): void => {
  const { oldPath, newPath } = rename;
  const original = moving.base.get(oldPath);
  const kept = moving.other.get(oldPath);
  if (original === undefined || kept === undefined) return;
  if (moving.other.has(newPath) || moving.otherSources.has(oldPath)) return;
  moving.base.set(newPath, original);
  moving.base.delete(oldPath);
  moving.other.set(newPath, kept);
  moving.other.delete(oldPath);
  moving.vacated.add(oldPath);
  moving.sidePaths.set(newPath, sidePathsOf(rename));
};

/** A side whose tree was absent keeps no entry a rename could move. */
const asTree = (entries: Entries, original: FlatTree | undefined): FlatTree | undefined =>
  original === undefined ? undefined : { entries };

/**
 * git's ort moves each renamed path's merge-base and other-side versions to
 * the rename's destination before the per-path merge, so a file renamed on
 * one side and edited on the other merges into the new path.
 */
export function applyMergeRenames(
  base: FlatTree | undefined,
  ours: FlatTree | undefined,
  theirs: FlatTree | undefined,
  renames: MergeRenames,
): RenamedMergeInput {
  if (base === undefined || !hasRenames(renames)) {
    return { base, ours, theirs, vacated: new Set(), sidePaths: new Map() };
  }
  const baseEntries: Entries = new Map(base.entries);
  const ourEntries: Entries = new Map(ours?.entries);
  const theirEntries: Entries = new Map(theirs?.entries);
  const vacated = new Set<FilePath>();
  const sidePaths = new Map<FilePath, SidePaths>();
  const intoOurs = { base: baseEntries, other: ourEntries, vacated, sidePaths };
  const intoTheirs = { base: baseEntries, other: theirEntries, vacated, sidePaths };
  const oursMoving = { ...intoTheirs, otherSources: sourcesOf(renames.theirs) };
  const theirsMoving = { ...intoOurs, otherSources: sourcesOf(renames.ours) };
  for (const rename of renames.ours) {
    moveRename(rename, oursMoving, (r) => ({
      base: r.oldPath,
      ours: r.newPath,
      theirs: r.oldPath,
    }));
  }
  for (const rename of renames.theirs) {
    moveRename(rename, theirsMoving, (r) => ({
      base: r.oldPath,
      ours: r.oldPath,
      theirs: r.newPath,
    }));
  }
  return {
    base: { entries: baseEntries },
    ours: renames.theirs.length > 0 ? asTree(ourEntries, ours) : ours,
    theirs: renames.ours.length > 0 ? asTree(theirEntries, theirs) : theirs,
    vacated,
    sidePaths,
  };
}
