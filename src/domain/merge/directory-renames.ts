/**
 * git's ort directory rename detection (`merge-ort.c` `collect_rename_info`,
 * `get_provisional_directory_renames`, `handle_directory_level_conflicts`,
 * `compute_collisions`, `check_for_directory_rename`;
 * `diffcore-rename.c` `update_dir_rename_counts`): a directory one side
 * removed — its files renamed, by majority, into another directory — carries
 * along the paths the other side added or renamed into it.
 */
import type { FlatTree, FlatTreeEntry } from '../diff/flat-tree.js';
import type { FilePath } from '../objects/index.js';
import type { MergeRename, MergeRenames, SidePaths } from './merge-renames.js';

/** `merge.directoryRenames`: move silently, move as a file-location conflict, or not at all. */
export type DirectoryRenameMode = 'apply' | 'conflict' | 'none';

/** ort's `dirs_removed` relevance: why a removed directory's renames are counted. */
type Relevance = 'none' | 'ancestor' | 'self';

type DirectoryRenames = ReadonlyMap<string, string>;

const TOP_LEVEL = '';

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? TOP_LEVEL : path.slice(0, slash);
};

const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const directoriesOf = (tree: FlatTree): Set<string> => {
  const directories = new Set<string>();
  for (const path of tree.entries.keys()) {
    let directory = parentOf(path);
    while (directory !== TOP_LEVEL && !directories.has(directory)) {
      directories.add(directory);
      directory = parentOf(directory);
    }
  }
  return directories;
};

const addedPaths = (base: FlatTree, side: FlatTree): ReadonlyArray<FilePath> =>
  [...side.entries.keys()].filter((path) => !base.entries.has(path));

/**
 * One merge's per-tree scans, each computed once however many passes ask:
 * every directory a tree holds, and the paths a side added over `base`.
 */
export interface MergeTreeScans {
  readonly base: FlatTree;
  readonly directoriesOf: (tree: FlatTree) => ReadonlySet<string>;
  readonly addedPaths: (side: FlatTree) => ReadonlyArray<FilePath>;
}

const memoisedPerTree = <T>(compute: (tree: FlatTree) => T): ((tree: FlatTree) => T) => {
  const scanned = new WeakMap<FlatTree, T>();
  return (tree) => {
    const known = scanned.get(tree);
    if (known !== undefined) return known;
    const fresh = compute(tree);
    scanned.set(tree, fresh);
    return fresh;
  };
};

/** Fresh scans over `base` for one merge; the caller owns and drops them with it. */
export const scanMergeTrees = (base: FlatTree): MergeTreeScans => ({
  base,
  directoriesOf: memoisedPerTree(directoriesOf),
  addedPaths: memoisedPerTree((side) => addedPaths(base, side)),
});

/**
 * The directories `side` removed that `other` added a file directly into —
 * ort's `RELEVANT_FOR_SELF`: every source under them matters for its location.
 */
export function locationRelevantDirectories(
  scans: MergeTreeScans,
  side: FlatTree,
  other: FlatTree,
): ReadonlySet<string> {
  const sideDirectories = scans.directoriesOf(side);
  const baseDirectories = scans.directoriesOf(scans.base);
  const removed = (directory: string): boolean =>
    baseDirectories.has(directory) && !sideDirectories.has(directory);
  return new Set(scans.addedPaths(other).map(parentOf).filter(removed));
}

const hasAncestorIn = (directory: string, directories: ReadonlySet<string>): boolean => {
  for (let up = parentOf(directory); up !== TOP_LEVEL; up = parentOf(up)) {
    if (directories.has(up)) return true;
  }
  return false;
};

const removedDirectories = (
  scans: MergeTreeScans,
  side: FlatTree,
  relevant: ReadonlySet<string>,
): ReadonlyMap<string, Relevance> => {
  const sideDirectories = scans.directoriesOf(side);
  const removed = new Map<string, Relevance>();
  for (const directory of scans.directoriesOf(scans.base)) {
    if (sideDirectories.has(directory)) continue;
    if (relevant.has(directory)) removed.set(directory, 'self');
    else removed.set(directory, hasAncestorIn(directory, relevant) ? 'ancestor' : 'none');
  }
  return removed;
};

type Counts = Map<string, Map<string, number>>;

const increment = (counts: Counts, oldDirectory: string, newDirectory: string): void => {
  const targets = counts.get(oldDirectory) ?? new Map<string, number>();
  targets.set(newDirectory, (targets.get(newDirectory) ?? 0) + 1);
  counts.set(oldDirectory, targets);
};

/** `update_dir_rename_counts`: one rename votes for each directory level it moved as a whole. */
const countRename = (
  counts: Counts,
  removed: ReadonlyMap<string, Relevance>,
  { oldPath, newPath }: MergeRename,
): void => {
  let [oldPart, newPart, first] = [oldPath as string, newPath as string, true];
  while (true) {
    const [oldDirectory, newDirectory] = [parentOf(oldPart), parentOf(newPart)];
    const relevance = removed.get(oldDirectory);
    if (relevance === undefined) return;
    if (!first && baseNameOf(oldPart) !== baseNameOf(newPart)) return;
    if (relevance === 'self' || first) increment(counts, oldDirectory, newDirectory);
    first = false;
    // Stryker disable next-line LogicalOperator: equivalent — the next step returns anyway: a 'none' directory's removed parent is 'none', and an empty new part never matches the old basename
    if (relevance === 'none' || newDirectory === TOP_LEVEL) return;
    [oldPart, newPart] = [oldDirectory, newDirectory];
  }
};

/** `get_provisional_directory_renames`: the destination holding a strict majority of the votes. */
const majority = (targets: ReadonlyMap<string, number>): string | undefined => {
  // Stryker disable next-line BooleanLiteral: equivalent — every count is at least 1, so the first target always takes the count > max branch, which resets tied
  let [best, max, tied] = [undefined as string | undefined, 0, false];
  for (const [target, count] of targets) {
    if (count === max) tied = true;
    else if (count > max) [best, max, tied] = [target, count, false];
  }
  return tied ? undefined : best;
};

/** One side's directory renames, and whether a relevant directory split with no majority. */
interface ProvisionalRenames {
  readonly renames: DirectoryRenames;
  /** `CONFLICT (directory rename split)`: the merge is not clean, though nothing is staged. */
  readonly split: boolean;
}

const provisionalRenamesOf = (
  scans: MergeTreeScans,
  side: FlatTree,
  other: FlatTree,
  renames: ReadonlyArray<MergeRename>,
): ProvisionalRenames => {
  const removed = removedDirectories(scans, side, locationRelevantDirectories(scans, side, other));
  const counts: Counts = new Map();
  for (const rename of renames) countRename(counts, removed, rename);
  const directoryRenames = new Map<string, string>();
  let split = false;
  for (const [source, targets] of counts) {
    if (removed.get(source) === 'none') continue;
    const target = majority(targets);
    if (target === undefined) split = true;
    else directoryRenames.set(source, target);
  }
  return { renames: directoryRenames, split };
};

/** The directories `side` renamed, each to the destination most of its files moved into. */
export function directoryRenamesOf(
  base: FlatTree,
  side: FlatTree,
  other: FlatTree,
  renames: ReadonlyArray<MergeRename>,
): DirectoryRenames {
  return provisionalRenamesOf(scanMergeTrees(base), side, other, renames).renames;
}

/** The trees, renames and moved paths once directory renames carried each side's paths along. */
export interface DirectoryRenamedInput {
  readonly ours: FlatTree;
  readonly theirs: FlatTree;
  readonly renames: MergeRenames;
  /** Moved paths git records as `CONFLICT (file location)` rather than taking. */
  readonly fileLocations: ReadonlySet<FilePath>;
  /** Where the moved paths were, merged as deleted. */
  readonly vacated: ReadonlySet<FilePath>;
  /** Where each side held a moved path, for git's `<label>:<path>` markers. */
  readonly sidePaths: ReadonlyMap<FilePath, SidePaths>;
  /** `false` when a directory rename split, collided or met a path in the way — nothing staged for it. */
  readonly clean: boolean;
}

const movedSidePaths = (
  ourMoves: ReadonlyMap<FilePath, FilePath>,
  theirMoves: ReadonlyMap<FilePath, FilePath>,
): ReadonlyMap<FilePath, SidePaths> => {
  const sidePaths = new Map<FilePath, SidePaths>();
  for (const [from, to] of ourMoves) sidePaths.set(to, { base: to, ours: from, theirs: to });
  for (const [from, to] of theirMoves) sidePaths.set(to, { base: to, ours: to, theirs: from });
  return sidePaths;
};

/** `check_dir_renamed`: the deepest renamed directory holding `path`. */
const renamedDirectoryOf = (
  path: string,
  directoryRenames: DirectoryRenames,
): string | undefined => {
  for (let directory = parentOf(path); ; directory = parentOf(directory)) {
    if (directoryRenames.has(directory)) return directory;
    if (directory === TOP_LEVEL) return undefined;
  }
};

/** `apply_dir_rename`; a renamed directory is never the top level, which no side removes. */
const movedPath = (path: string, from: string, to: string): FilePath => {
  const rest = path.slice(from.length + 1);
  return (to === TOP_LEVEL ? rest : `${to}/${rest}`) as FilePath;
};

const throughDirectoryRenames = (
  path: string,
  directoryRenames: DirectoryRenames,
): FilePath | undefined => {
  const from = renamedDirectoryOf(path, directoryRenames);
  if (from === undefined) return undefined;
  return movedPath(path, from, directoryRenames.get(from) as string);
};

/** `compute_collisions`: each moved path with every path the directory renames send there. */
const collisionsOf = (
  paths: ReadonlyArray<FilePath>,
  directoryRenames: DirectoryRenames,
): ReadonlyMap<FilePath, ReadonlyArray<FilePath>> => {
  const collisions = new Map<FilePath, FilePath[]>();
  for (const path of paths) {
    const moved = throughDirectoryRenames(path, directoryRenames);
    if (moved !== undefined) collisions.set(moved, [...(collisions.get(moved) ?? []), path]);
  }
  return collisions;
};

interface SideMove {
  readonly scans: MergeTreeScans;
  readonly side: FlatTree;
  /** The other side's directory renames, applied to this side's paths. */
  readonly directoryRenames: DirectoryRenames;
  /** This side's own directory renames: a destination it renamed again is skipped. */
  readonly exclusions: DirectoryRenames;
  readonly collisions: ReadonlyMap<FilePath, ReadonlyArray<FilePath>>;
  readonly otherCollisions: ReadonlyMap<FilePath, ReadonlyArray<FilePath>>;
}

/** `path_in_way`, for a path this side or the base already holds. */
const inTheWay = ({ scans, side }: SideMove, path: FilePath): boolean =>
  side.entries.has(path) || scans.base.entries.has(path);

/** `handle_path_level_conflicts` refusing a move: a collision or a path in the way. */
const BLOCKED = Symbol('blocked');

/** `check_for_directory_rename` + `handle_path_level_conflicts`; renamed-again destinations are skipped clean. */
const destinationOf = (move: SideMove, path: FilePath): FilePath | typeof BLOCKED | undefined => {
  if (move.otherCollisions.has(path)) return undefined;
  const from = renamedDirectoryOf(path, move.directoryRenames);
  if (from === undefined) return undefined;
  const to = move.directoryRenames.get(from) as string;
  if (move.exclusions.has(to)) return undefined;
  const moved = movedPath(path, from, to);
  const sources = move.collisions.get(moved) as ReadonlyArray<FilePath>;
  if (sources.length > 1 || inTheWay(move, moved)) return BLOCKED;
  return moved;
};

interface SideMoves {
  readonly found: ReadonlyMap<FilePath, FilePath>;
  readonly clean: boolean;
}

const moves = (move: SideMove): SideMoves => {
  const found = new Map<FilePath, FilePath>();
  let clean = true;
  // A side's additions are its rename targets too — ort's `A` and `R` pairs.
  for (const path of move.scans.addedPaths(move.side)) {
    const destination = destinationOf(move, path);
    if (destination === BLOCKED) clean = false;
    else if (destination !== undefined) found.set(path, destination);
  }
  return { found, clean };
};

const movedTree = (tree: FlatTree, moved: ReadonlyMap<FilePath, FilePath>): FlatTree => {
  if (moved.size === 0) return tree;
  const entries = new Map<FilePath, FlatTreeEntry>();
  for (const [path, entry] of tree.entries) entries.set(moved.get(path) ?? path, entry);
  return { entries };
};

const movedRenames = (
  renames: ReadonlyArray<MergeRename>,
  moved: ReadonlyMap<FilePath, FilePath>,
): ReadonlyArray<MergeRename> => {
  if (moved.size === 0) return renames;
  return renames.map((rename) => {
    const newPath = moved.get(rename.newPath);
    return newPath === undefined ? rename : { ...rename, newPath };
  });
};

/** `handle_directory_level_conflicts`: a directory both sides renamed is renamed by neither. */
const withoutShared = (mine: DirectoryRenames, theirs: DirectoryRenames): DirectoryRenames =>
  // Stryker disable next-line MethodExpression: equivalent — a directory both sides renamed is removed on both, so no added path lies under it and no rename lands in it
  new Map([...mine].filter(([source]) => !theirs.has(source)));

const unchanged = (
  ours: FlatTree,
  theirs: FlatTree,
  renames: MergeRenames,
): DirectoryRenamedInput => ({
  ours,
  theirs,
  renames,
  fileLocations: new Set(),
  vacated: new Set(),
  sidePaths: new Map(),
  clean: true,
});

interface BothSidesMoves {
  readonly ours: SideMoves;
  readonly theirs: SideMoves;
}

/** `collect_renames` for each side, against the other side's surviving directory renames. */
const bothSidesMoves = (
  scans: MergeTreeScans,
  sides: { readonly ours: FlatTree; readonly theirs: FlatTree },
  byOurs: DirectoryRenames,
  byTheirs: DirectoryRenames,
): BothSidesMoves => {
  const ourMove: SideMove = {
    scans,
    side: sides.ours,
    directoryRenames: byTheirs,
    exclusions: byOurs,
    collisions: collisionsOf(scans.addedPaths(sides.ours), byTheirs),
    otherCollisions: collisionsOf(scans.addedPaths(sides.theirs), byOurs),
  };
  return { ours: moves(ourMove), theirs: moves(mirroredMove(ourMove, sides.theirs)) };
};

/** The other side's move: every renames and collisions pair swaps its roles. */
const mirroredMove = (move: SideMove, side: FlatTree): SideMove => ({
  scans: move.scans,
  side,
  directoryRenames: move.exclusions,
  exclusions: move.directoryRenames,
  collisions: move.otherCollisions,
  otherCollisions: move.collisions,
});

const movedInput = (
  { ours, theirs, renames }: Pick<DirectoryRenamedInput, 'ours' | 'theirs' | 'renames'>,
  sideMoves: BothSidesMoves,
): DirectoryRenamedInput => {
  const [ourMoves, theirMoves] = [sideMoves.ours.found, sideMoves.theirs.found];
  const moved = [...ourMoves.values(), ...theirMoves.values()];
  return {
    ours: movedTree(ours, ourMoves),
    theirs: movedTree(theirs, theirMoves),
    renames: {
      ...renames,
      ours: movedRenames(renames.ours, ourMoves),
      theirs: movedRenames(renames.theirs, theirMoves),
    },
    fileLocations: new Set(renames.directoryRenames === 'conflict' ? moved : []),
    vacated: new Set([...ourMoves.keys(), ...theirMoves.keys()]),
    sidePaths: movedSidePaths(ourMoves, theirMoves),
    clean: sideMoves.ours.clean && sideMoves.theirs.clean,
  };
};

/**
 * Moves each side's additions and rename targets inside a directory the other
 * side renamed into that directory's new home, as ort's `collect_renames`
 * does; in `conflict` mode the moved paths are listed as file locations.
 */
export function applyDirectoryRenames(
  base: FlatTree | undefined,
  ours: FlatTree,
  theirs: FlatTree,
  renames: MergeRenames,
): DirectoryRenamedInput {
  if (base === undefined || (renames.directoryRenames ?? 'none') === 'none')
    return unchanged(ours, theirs, renames);
  // No file rename casts a vote, so no directory is renamed, split, or moves a path.
  if (renames.ours.length === 0 && renames.theirs.length === 0)
    return unchanged(ours, theirs, renames);
  const scans = scanMergeTrees(base);
  const oursRenamed = provisionalRenamesOf(scans, ours, theirs, renames.ours);
  const theirsRenamed = provisionalRenamesOf(scans, theirs, ours, renames.theirs);
  const byOurs = withoutShared(oursRenamed.renames, theirsRenamed.renames);
  const byTheirs = withoutShared(theirsRenamed.renames, oursRenamed.renames);
  const sideMoves = bothSidesMoves(scans, { ours, theirs }, byOurs, byTheirs);
  const moved = movedInput({ ours, theirs, renames }, sideMoves);
  return oursRenamed.split || theirsRenamed.split ? { ...moved, clean: false } : moved;
}
