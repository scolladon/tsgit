/**
 * git's ort rename detection for a merge (`merge-ort.c`
 * `detect_regular_renames`): per side, the merge-base paths that side deleted
 * are paired with the paths it added, renames only — no copies, no breaks, the
 * empty blob never a candidate. A deleted path is a source only when the other
 * side changed it (ort's relevant sources), and a side with no relevant source
 * or no addition skips detection entirely. `-X` overrides (`overrides`) win over
 * `merge.renames` / `diff.renames` and set the similarity threshold.
 */
import { primaryPath } from '../../domain/diff/change-path.js';
import type {
  AddChange,
  DeleteChange,
  DiffChange,
  RenameChange,
} from '../../domain/diff/diff-change.js';
import type { FlatTree } from '../../domain/diff/flat-tree.js';
import { sortByPath } from '../../domain/diff/path-compare.js';
import { detectRenames, type RenameDetectOptions } from '../../domain/diff/rename-detect.js';
import {
  type DirectoryRenameMode,
  locationRelevantDirectories,
  type MergeTreeScans,
  scanMergeTrees,
} from '../../domain/merge/directory-renames.js';
import { type MergeRename, type MergeRenames, NO_MERGE_RENAMES } from '../../domain/merge/index.js';
import type { OrtRenameOptions } from '../../domain/merge/strategy-options.js';
import { emptyBlobOid, type FilePath, type ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { detectSimilarityRenames } from './detect-similarity-renames.js';
import { readMergeRenameConfig } from './internal/merge-rename-config.js';

interface SidePass {
  readonly base: FlatTree;
  readonly side: FlatTree;
  readonly other: FlatTree;
  /** Shared by both sides' passes, so each tree is scanned once per merge. */
  readonly scans: MergeTreeScans;
  readonly empty: ObjectId;
  readonly limit: number;
  readonly threshold: number | undefined;
  readonly directoryRenames: DirectoryRenameMode;
}

const NO_DIRECTORIES: ReadonlySet<string> = new Set();

/** ort's location relevance: the directories this side removed that the other side added into. */
const locationRelevant = (pass: SidePass): ReadonlySet<string> =>
  pass.directoryRenames === 'none'
    ? NO_DIRECTORIES
    : locationRelevantDirectories(pass.scans, pass.side, pass.other);

const underAny = (path: FilePath, directories: ReadonlySet<string>): boolean => {
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
    if (directories.has(path.slice(0, slash))) return true;
  }
  return false;
};

/** Every merge-base path this side deleted — the empty blob never a source. */
const deletions = ({ base, side, empty }: SidePass): DeleteChange[] => {
  const deletes: DeleteChange[] = [];
  for (const [path, entry] of base.entries) {
    if (side.entries.has(path) || entry.id === empty) continue;
    deletes.push({ type: 'delete', oldPath: path, oldId: entry.id, oldMode: entry.mode });
  }
  return deletes;
};

/** ort's content relevance: the other side changed (or deleted) what this side deleted. */
const isContentRelevant = ({ other }: SidePass, deleted: DeleteChange): boolean => {
  const kept = other.entries.get(deleted.oldPath);
  return kept === undefined || kept.id !== deleted.oldId || kept.mode !== deleted.oldMode;
};

const relevantSources = (pass: SidePass, deletes: ReadonlyArray<DeleteChange>): Set<FilePath> => {
  const located = deletes.length > 0 ? locationRelevant(pass) : NO_DIRECTORIES;
  const relevant = (deleted: DeleteChange): boolean =>
    isContentRelevant(pass, deleted) || underAny(deleted.oldPath, located);
  return new Set(deletes.filter(relevant).map(sourcePath));
};

const additions = ({ base, side, empty }: SidePass): AddChange[] => {
  const adds: AddChange[] = [];
  for (const [path, entry] of side.entries) {
    if (base.entries.has(path) || entry.id === empty) continue;
    adds.push({ type: 'add', newPath: path, newId: entry.id, newMode: entry.mode });
  }
  return adds;
};

const isRename = (change: DiffChange): change is RenameChange => change.type === 'rename';

interface SideRenames {
  readonly renames: ReadonlyArray<MergeRename>;
  /** git's `needed_rename_limit`: what the similarity pass needed, 0 when it ran. */
  readonly neededLimit: number;
}

const NO_SIDE_RENAMES: SideRenames = { renames: [], neededLimit: 0 };

const RENAME_LIMIT_WARNING = 'exhaustive rename detection was skipped due to too many files.';

/** git's `too_many_rename_candidates` over the sources and destinations the exact pass left. */
const neededLimit = (left: ReadonlyArray<DiffChange>, limit: number): number => {
  // Stryker disable next-line EqualityOperator: equivalent — `!==` swaps sources and destinations (left holds only adds and deletes), and both their product and their max are symmetric.
  const sources = left.filter((change) => change.type === 'delete').length;
  const destinations = left.length - sources;
  return sources * destinations > limit * limit ? Math.max(sources, destinations) : 0;
};

const toMergeRename = ({ oldPath, newPath }: RenameChange): MergeRename => ({ oldPath, newPath });

const sourcePath = ({ oldPath }: DeleteChange): FilePath => oldPath;

const similarityOptions = ({ limit, threshold }: SidePass): RenameDetectOptions =>
  threshold === undefined ? { limit } : { limit, threshold };

/**
 * `diffcore_rename_extended`: the exact pass pairs every deleted path, then
 * only the relevant sources it left go on to the similarity pass.
 */
const sideRenames = async (ctx: Context, pass: SidePass): Promise<SideRenames> => {
  const deletes = deletions(pass);
  const relevant = relevantSources(pass, deletes);
  const adds = relevant.size > 0 ? additions(pass) : [];
  if (adds.length === 0) return NO_SIDE_RENAMES;
  const changes = sortByPath<DiffChange>([...deletes, ...adds], primaryPath);
  const exact = detectRenames({ changes });
  const left = exact.changes.filter(
    (change) => change.type === 'add' || (change.type === 'delete' && relevant.has(change.oldPath)),
  );
  const similar = await detectSimilarityRenames(ctx, { changes: left }, similarityOptions(pass));
  // An untouched source's rename merges as its delete and add would: only relevant ones are kept.
  const renames = [...exact.changes, ...similar.changes]
    .filter(isRename)
    .filter((rename) => relevant.has(rename.oldPath));
  return {
    renames: sortByPath(renames, primaryPath).map(toMergeRename),
    neededLimit: neededLimit(left, pass.limit),
  };
};

/** git's `diff_warn_rename_limit`, once for the whole merge. */
const warnRenameLimit = (ctx: Context, needed: number): void => {
  if (needed === 0) return;
  ctx.logger?.warn?.(RENAME_LIMIT_WARNING);
  ctx.logger?.warn?.(
    `you may want to set your merge.renamelimit variable to at least ${needed} and retry the command.`,
  );
};

export const detectMergeRenames = async (
  ctx: Context,
  base: FlatTree | undefined,
  ours: FlatTree,
  theirs: FlatTree,
  overrides: OrtRenameOptions = {},
): Promise<MergeRenames> => {
  const config = await readMergeRenameConfig(ctx);
  if (!(overrides.detect ?? config.detect) || base === undefined) return NO_MERGE_RENAMES;
  const shared = {
    base,
    scans: scanMergeTrees(base),
    empty: emptyBlobOid(ctx.hashConfig),
    limit: config.limit,
    threshold: overrides.threshold,
    directoryRenames: config.directoryRenames,
  };
  const oursSide = await sideRenames(ctx, { ...shared, side: ours, other: theirs });
  const theirsSide = await sideRenames(ctx, { ...shared, side: theirs, other: ours });
  warnRenameLimit(ctx, Math.max(oursSide.neededLimit, theirsSide.neededLimit));
  return {
    ours: oursSide.renames,
    theirs: theirsSide.renames,
    directoryRenames: config.directoryRenames,
  };
};
