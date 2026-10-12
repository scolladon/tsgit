/**
 * The changed-path Bloom filter of each commit a commit-graph write covers,
 * as git's `get_or_compute_bloom_filter` derives it: a recursive,
 * rename-blind tree diff against the first parent only (a root against the
 * empty tree), each changed leaf's raw path bytes hashed with its leading
 * directories — unless the existing graph already stores one at the same
 * settings and hash version, which git copies as it is.
 */
import {
  type BloomFilterSettings,
  changedPathFilter,
} from '../../../domain/commit/bloom-filter.js';
import {
  type CommitGraphBloomSettings,
  positionOf,
  storedBloomFilter,
} from '../../../domain/commit/commit-graph.js';
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
import type { LocalGraphLayer } from './local-commit-graph-layers.js';
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

/** A commit's filter as the existing graph stores it, or `undefined`. */
export type StoredFilterLookup = (id: ObjectId) => Uint8Array | undefined;

const NOTHING_STORED: StoredFilterLookup = () => undefined;

const sameSettings = (a: CommitGraphBloomSettings, b: CommitGraphBloomSettings): boolean =>
  a.hashVersion === b.hashVersion &&
  a.numHashes === b.numHashes &&
  a.bitsPerEntry === b.bitsPerEntry;

/**
 * git's `validate_mixed_bloom_settings`: the top-most layer storing filters
 * sets the reference and a layer whose settings differ is ignored. Only
 * filters at the written hash version are reused; git upgrades the others
 * only when no path has a high bit, where recomputing yields the same bytes.
 */
export function storedFilterLookup(
  layers: readonly LocalGraphLayer[],
  settings: BloomFilterSettings,
): StoredFilterLookup {
  const reference = [...layers].reverse().find(({ layer }) => layer.bloomSettings)
    ?.layer.bloomSettings;
  if (reference === undefined || reference.hashVersion !== settings.hashVersion) {
    return NOTHING_STORED;
  }
  const usable = layers.filter(
    ({ layer }) => layer.bloomSettings && sameSettings(layer.bloomSettings, reference),
  );
  return (id) => {
    for (const { layer } of usable) {
      const position = positionOf(layer, id);
      if (position !== undefined) return storedBloomFilter(layer, position);
    }
    return undefined;
  };
}

/** git's `commitGraph.maxNewFilters`: at most `limit` filters computed, lowest generation first. */
export interface NewFilterBudget {
  readonly limit: number;
  /** The generation `commit_gen_cmp` orders by; equal ones fall back to the committer date. */
  readonly generationOf: (id: ObjectId) => number;
}

const UNLIMITED: NewFilterBudget = { limit: Number.POSITIVE_INFINITY, generationOf: () => 0 };

/** git's `compute_bloom_filters` order, ties kept in oid order. */
const inBudgetOrder = (
  commits: readonly CommitGraphWriterCommit[],
  { generationOf }: NewFilterBudget,
): readonly CommitGraphWriterCommit[] =>
  [...commits].sort(
    (a, b) => generationOf(a.id) - generationOf(b.id) || a.committerDate - b.committerDate,
  );

async function computedFilter(
  ctx: Context,
  commit: CommitGraphWriterCommit,
  treeOf: ReadonlyMap<ObjectId, ObjectId>,
  settings: BloomFilterSettings,
): Promise<Uint8Array> {
  const parentTree = await firstParentTree(ctx, commit, treeOf);
  const paths = await firstParentChangedPaths(
    ctx,
    commit.rootTree,
    parentTree,
    settings.maxChangedPaths,
  );
  return changedPathFilter(paths, settings);
}

/**
 * One filter per commit, keyed by its id; a non-empty stored filter is reused,
 * as git does, without spending the budget. A commit past it gets none.
 */
export async function changedPathFilters(
  ctx: Context,
  commits: readonly CommitGraphWriterCommit[],
  settings: BloomFilterSettings,
  stored: StoredFilterLookup = NOTHING_STORED,
  budget: NewFilterBudget = UNLIMITED,
): Promise<ReadonlyMap<ObjectId, Uint8Array>> {
  const treeOf = new Map(commits.map((commit) => [commit.id, commit.rootTree]));
  const filters = new Map<ObjectId, Uint8Array>();
  let computed = 0;
  for (const commit of inBudgetOrder(commits, budget)) {
    const reused = stored(commit.id);
    if (reused !== undefined && reused.length > 0) {
      filters.set(commit.id, reused);
      continue;
    }
    if (computed >= budget.limit) continue;
    computed += 1;
    filters.set(commit.id, await computedFilter(ctx, commit, treeOf, settings));
  }
  return filters;
}
