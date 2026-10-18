import { operationAborted } from '../../../domain/error.js';
import {
  type IndexPath,
  type IndexPathKey,
  indexPathOfEscaped,
} from '../../../domain/git-index/index-path-key.js';
import { decodeEscapingInvalid } from '../../../domain/objects/encoding.js';
import { treeDepthExceeded } from '../../../domain/objects/error.js';
import { FILE_MODE } from '../../../domain/objects/file-mode.js';
import type {
  FileMode,
  FilePath,
  ObjectId,
  Tree,
  TreeEntry,
} from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readTree } from '../read-tree.js';
import { exceedsMaxTreeDepth } from '../validators.js';
import { resolveMaxTreeDepth } from './resolve-max-tree-depth.js';

export interface FileVersion extends IndexPath {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

/** What differs between two trees, with every identical subtree set aside unread. */
export interface PrunedTreeDiff {
  /** Files of the old tree found under a directory the two trees do not share. */
  readonly oldFiles: ReadonlyArray<FileVersion>;
  /** Directories (escaped path, trailing slash) whose tree object is the same on both sides. */
  readonly sharedDirs: ReadonlySet<string>;
}

/** Marks the two root trees as the same object. */
const WHOLE_TREE = '';

const EMPTY_TREE_ENTRIES: ReadonlyArray<TreeEntry> = [];

const isDir = (entry: TreeEntry | undefined): entry is TreeEntry =>
  entry?.mode === FILE_MODE.DIRECTORY;

const nameOf = (entry: TreeEntry): string => decodeEscapingInvalid(entry.nameBytes);

const byName = (entries: ReadonlyArray<TreeEntry>): Map<string, TreeEntry> =>
  new Map(entries.map((entry) => [nameOf(entry), entry]));

const subtreeEntries = async (
  ctx: Context,
  entry: TreeEntry | undefined,
): Promise<Tree['entries']> =>
  isDir(entry) ? (await readTree(ctx, entry.id)).entries : EMPTY_TREE_ENTRIES;

interface Walk {
  readonly ctx: Context;
  readonly maxDepth: number;
  readonly oldFiles: FileVersion[];
  readonly sharedDirs: Set<string>;
}

const fileVersion = (key: string, entry: TreeEntry): FileVersion => ({
  ...indexPathOfEscaped(key as FilePath),
  id: entry.id,
  mode: entry.mode,
});

const sameTree = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean =>
  isDir(a) && isDir(b) && a.id === b.id;

const visitPair = async (
  walk: Walk,
  prefix: string,
  depth: number,
  [oldEntry, newEntry]: readonly [TreeEntry | undefined, TreeEntry | undefined],
  name: string,
): Promise<void> => {
  const key = `${prefix}${name}`;
  if (sameTree(oldEntry, newEntry)) {
    walk.sharedDirs.add(`${key}/`);
    return;
  }
  if (oldEntry !== undefined && !isDir(oldEntry)) walk.oldFiles.push(fileVersion(key, oldEntry));
  if (!isDir(oldEntry) && !isDir(newEntry)) return;
  await walkPair(
    walk,
    `${key}/`,
    depth + 1,
    await subtreeEntries(walk.ctx, oldEntry),
    await subtreeEntries(walk.ctx, newEntry),
  );
};

const walkPair = async (
  walk: Walk,
  prefix: string,
  depth: number,
  oldEntries: ReadonlyArray<TreeEntry>,
  newEntries: ReadonlyArray<TreeEntry>,
): Promise<void> => {
  if (walk.ctx.signal?.aborted) throw operationAborted();
  if (exceedsMaxTreeDepth(depth, walk.maxDepth)) throw treeDepthExceeded(depth);
  const [olds, news] = [byName(oldEntries), byName(newEntries)];
  for (const name of new Set([...olds.keys(), ...news.keys()])) {
    await visitPair(walk, prefix, depth, [olds.get(name), news.get(name)], name);
  }
};

/**
 * Walks two trees side by side and never opens a directory whose tree object is
 * identical at the same path on both sides, as git's two-way unpack prunes them.
 */
export const diffTreesPruned = async (
  ctx: Context,
  oldTree: ObjectId,
  newTree: ObjectId,
): Promise<PrunedTreeDiff> => {
  const walk: Walk = {
    ctx,
    maxDepth: await resolveMaxTreeDepth(ctx),
    oldFiles: [],
    sharedDirs: new Set(),
  };
  if (oldTree === newTree) walk.sharedDirs.add(WHOLE_TREE);
  else {
    const [oldRoot, newRoot] = [await readTree(ctx, oldTree), await readTree(ctx, newTree)];
    await walkPair(walk, '', 0, oldRoot.entries, newRoot.entries);
  }
  return { oldFiles: walk.oldFiles, sharedDirs: walk.sharedDirs };
};

/** Whether `key` sits below one of the shared directories. */
export const isBelowShared = (sharedDirs: ReadonlySet<string>, key: IndexPathKey): boolean => {
  if (sharedDirs.has(WHOLE_TREE)) return true;
  for (let slash = key.indexOf('/'); slash !== -1; slash = key.indexOf('/', slash + 1)) {
    if (sharedDirs.has(key.slice(0, slash + 1))) return true;
  }
  return false;
};
