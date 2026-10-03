/**
 * The changed-path Bloom filter of each commit a commit-graph write covers,
 * as git's `get_or_compute_bloom_filter` derives it: a recursive,
 * rename-blind tree diff against the first parent only (a root against the
 * empty tree), each changed leaf's raw path bytes hashed with its leading
 * directories.
 */
import {
  type BloomFilterSettings,
  changedPathFilter,
} from '../../../domain/commit/bloom-filter.js';
import type { CommitGraphWriterCommit } from '../../../domain/commit/commit-graph-writer.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import {
  advanceCursor,
  compareCursorNames,
  cursorOid,
  cursorsSame,
  openTreeCursor,
  type TreeCursor,
} from '../../../domain/objects/tree-cursor.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { readRawTreeById } from './raw-tree-io.js';

const SLASH = 0x2f;
const EMPTY = new Uint8Array(0);

/** The walk's accumulator — local to one diff, never shared. */
interface PathWalk {
  readonly ctx: Context;
  readonly limit: number;
  readonly paths: Uint8Array[];
}

const childPath = (prefix: Uint8Array, cursor: TreeCursor): Uint8Array => {
  const name = cursor.buf.subarray(cursor.nameStart, cursor.nameEnd);
  if (prefix.length === 0) return name.slice();
  const path = new Uint8Array(prefix.length + 1 + name.length);
  path.set(prefix);
  path[prefix.length] = SLASH;
  path.set(name, prefix.length + 1);
  return path;
};

const openTree = async (walk: PathWalk, tree: ObjectId | undefined): Promise<TreeCursor> =>
  openTreeCursor(
    tree === undefined ? EMPTY : await readRawTreeById(walk.ctx, tree),
    walk.ctx.hashConfig,
  );

/** One merge-join step: the entry sorting first, or a same-named pair (same kind, since a
 *  directory sorts as if `/`-suffixed). A leaf is recorded; a directory is descended. */
async function step(
  walk: PathWalk,
  old: TreeCursor,
  now: TreeCursor,
  prefix: Uint8Array,
  order: number,
): Promise<void> {
  if (order === 0 && cursorsSame(old, now)) return;
  const entry = order > 0 ? now : old;
  const path = childPath(prefix, entry);
  if (!entry.isDir) {
    walk.paths.push(path);
    return;
  }
  const oldTree = order <= 0 ? cursorOid(old) : undefined;
  await diffLevel(walk, oldTree, order >= 0 ? cursorOid(now) : undefined, path);
}

async function diffLevel(
  walk: PathWalk,
  oldTree: ObjectId | undefined,
  newTree: ObjectId | undefined,
  prefix: Uint8Array,
): Promise<void> {
  const old = await openTree(walk, oldTree);
  const now = await openTree(walk, newTree);
  while ((!old.done || !now.done) && walk.paths.length <= walk.limit) {
    const order = old.done ? 1 : now.done ? -1 : compareCursorNames(old, now);
    await step(walk, old, now, prefix, order);
    if (order <= 0) advanceCursor(old);
    if (order >= 0) advanceCursor(now);
  }
}

/**
 * Every leaf `tree` changes against `parentTree`, in tree order. Stops once
 * past `limit` paths: git then writes the too-large marker whatever the rest holds.
 */
export async function firstParentChangedPaths(
  ctx: Context,
  tree: ObjectId,
  parentTree: ObjectId | undefined,
  limit: number,
): Promise<readonly Uint8Array[]> {
  const walk: PathWalk = { ctx, limit, paths: [] };
  await diffLevel(walk, parentTree, tree, EMPTY);
  return walk.paths;
}

async function commitTree(ctx: Context, id: ObjectId): Promise<ObjectId> {
  const object = await readObject(ctx, id);
  if (object.type !== 'commit') throw unexpectedObjectType('commit', object.type, id);
  return object.data.tree;
}

async function firstParentTree(
  ctx: Context,
  commit: CommitGraphWriterCommit,
  treeOf: ReadonlyMap<ObjectId, ObjectId>,
): Promise<ObjectId | undefined> {
  const parent = commit.parents[0];
  if (parent === undefined) return undefined;
  return treeOf.get(parent) ?? commitTree(ctx, parent);
}

/** One filter per commit, keyed by its id. */
export async function changedPathFilters(
  ctx: Context,
  commits: readonly CommitGraphWriterCommit[],
  settings: BloomFilterSettings,
): Promise<ReadonlyMap<ObjectId, Uint8Array>> {
  const treeOf = new Map(commits.map((commit) => [commit.id, commit.rootTree]));
  const filters = new Map<ObjectId, Uint8Array>();
  for (const commit of commits) {
    const parentTree = await firstParentTree(ctx, commit, treeOf);
    const paths = await firstParentChangedPaths(
      ctx,
      commit.rootTree,
      parentTree,
      settings.maxChangedPaths,
    );
    filters.set(commit.id, changedPathFilter(paths, settings));
  }
  return filters;
}
