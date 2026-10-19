import { toRepairedCacheTree } from '../../../domain/git-index/cache-tree-abort.js';
import {
  type CacheTreePlan,
  type PlannedNode,
  planCacheTree,
  type TreeBuild,
  toCacheTreeEntry,
} from '../../../domain/git-index/cache-tree-update.js';
import type { CacheTreeEntry, IndexEntry } from '../../../domain/git-index/index-entry.js';
import { pathBytesOf } from '../../../domain/git-index/index-path-key.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import {
  emptyTreeOid,
  FILE_MODE,
  type ObjectId,
  type TreeEntry,
} from '../../../domain/objects/index.js';
import { treeEntry } from '../../../domain/objects/tree.js';
import type { Context } from '../../../ports/context.js';
import { hasObject } from '../has-object.js';
import { readDeclaredObjectHeader } from '../read-object.js';
import { writeTree } from '../write-tree.js';
import { limiterFor } from './concurrency.js';
import type { ConcurrencyLimiter } from './concurrency-limiter.js';
import { serializeAndHash } from './serialize-and-hash.js';

const ROOT = 0;

export type TreeSink = 'write' | 'repair';

export interface WrittenCacheTree {
  readonly cacheTree: CacheTreeEntry;
  readonly rootTree: ObjectId;
}

export interface RepairedCacheTree {
  readonly cacheTree: CacheTreeEntry;
}

type Ids = (ObjectId | undefined)[];

/** git answers for the empty tree from a built-in cached object, stored or not. */
const presentIn = async (ctx: Context, id: ObjectId): Promise<boolean> =>
  id === emptyTreeOid(ctx.hashConfig) || hasObject(ctx, id, { mode: 'recheck' });

/** A root a commit is about to name must be a tree, whatever the carried TREE claims. */
export const assertIsTree = async (ctx: Context, id: ObjectId): Promise<void> => {
  if (id === emptyTreeOid(ctx.hashConfig)) return;
  const { type } = await readDeclaredObjectHeader(ctx, id);
  if (type !== 'tree') throw unexpectedObjectType('tree', type, id);
};

const assertReusedRootIsTree = async (ctx: Context, plan: CacheTreePlan): Promise<void> => {
  const root = (plan.nodes[ROOT] as PlannedNode).reused;
  if (root !== undefined) await assertIsTree(ctx, root);
};

/** git existence-checks only the topmost valid node of a reused subtree. */
const topmostReused = (plan: CacheTreePlan): number[] => {
  if ((plan.nodes[ROOT] as PlannedNode).reused !== undefined) return [ROOT];
  return plan.builds.flatMap((build) =>
    build.subtrees.filter((child) => (plan.nodes[child] as PlannedNode).reused !== undefined),
  );
};

const missingAmong = async (
  ctx: Context,
  limiter: ConcurrencyLimiter,
  plan: CacheTreePlan,
  present: Set<ObjectId>,
): Promise<number[]> => {
  const checked = await Promise.all(
    topmostReused(plan).map(async (index) => {
      const id = (plan.nodes[index] as PlannedNode).reused as ObjectId;
      if (present.has(id)) return undefined;
      if (await limiter.run(() => presentIn(ctx, id))) {
        present.add(id);
        return undefined;
      }
      return index;
    }),
  );
  return checked.filter((index): index is number => index !== undefined);
};

const withoutObjects = (node: CacheTreeEntry, missing: ReadonlySet<ObjectId>): CacheTreeEntry => ({
  ...node,
  entryCount: node.id !== undefined && missing.has(node.id) ? -1 : node.entryCount,
  children: node.children.map((child) => withoutObjects(child, missing)),
});

interface SettledPlan {
  readonly plan: CacheTreePlan;
  readonly present: Set<ObjectId>;
}

/** Plans until every topmost reused node exists; a missing one is invalidated and rebuilt in either mode. */
const settlePlan = async (
  ctx: Context,
  limiter: ConcurrencyLimiter,
  entries: ReadonlyArray<IndexEntry>,
  carried: CacheTreeEntry | undefined,
): Promise<SettledPlan> => {
  const present = new Set<ObjectId>();
  let tree = carried;
  for (;;) {
    const plan = planCacheTree(entries, tree);
    const missing = await missingAmong(ctx, limiter, plan, present);
    if (missing.length === 0) return { plan, present };
    const ids = new Set(
      missing.map((index) => (plan.nodes[index] as PlannedNode).reused as ObjectId),
    );
    tree = withoutObjects(tree as CacheTreeEntry, ids);
  }
};

interface Layout {
  readonly depth: number[];
  readonly prefix: number[];
}

/** Children precede parents in `builds`, so walking it backwards visits parents first. */
const layoutOf = (plan: CacheTreePlan): Layout => {
  const layout: Layout = { depth: [0], prefix: [0] };
  for (let i = plan.builds.length - 1; i >= 0; i--) {
    const build = plan.builds[i] as TreeBuild;
    for (const child of build.subtrees) {
      layout.depth[child] = (layout.depth[build.node] as number) + 1;
      layout.prefix[child] =
        (layout.prefix[build.node] as number) +
        (plan.nodes[child] as PlannedNode).nameBytes.length +
        1;
    }
  }
  return layout;
};

const levelsDeepestFirst = (plan: CacheTreePlan, layout: Layout): TreeBuild[][] => {
  const levels: TreeBuild[][] = [];
  for (const build of plan.builds) {
    const depth = layout.depth[build.node] as number;
    while (levels.length <= depth) levels.push([]);
    (levels[depth] as TreeBuild[]).push(build);
  }
  return levels.reverse();
};

const subtreeEntries = (
  ctx: Context,
  plan: CacheTreePlan,
  build: TreeBuild,
  ids: Ids,
): TreeEntry[] | undefined => {
  const empty = emptyTreeOid(ctx.hashConfig);
  const out: TreeEntry[] = [];
  for (const child of build.subtrees) {
    const node = plan.nodes[child] as PlannedNode;
    const id = ids[child];
    if (id === undefined) return undefined;
    if (node.invalid && id === empty) continue;
    out.push(treeEntry(FILE_MODE.DIRECTORY, node.nameBytes, id));
  }
  return out;
};

const treeEntriesOf = (
  ctx: Context,
  plan: CacheTreePlan,
  build: TreeBuild,
  prefix: number,
  ids: Ids,
): TreeEntry[] | undefined => {
  const subtrees = subtreeEntries(ctx, plan, build, ids);
  if (subtrees === undefined) return undefined;
  const files = build.files.map((entry) =>
    treeEntry(entry.mode, pathBytesOf(entry).subarray(prefix), entry.id),
  );
  return [...files, ...subtrees];
};

type Leaf = (entries: ReadonlyArray<TreeEntry>) => Promise<ObjectId | undefined>;

const writeLeaf =
  (ctx: Context, limiter: ConcurrencyLimiter): Leaf =>
  (entries) =>
    limiter.run(() => writeTree(ctx, entries));

/** Repair hashes the tree and keeps its id only when the object is already stored. */
const hashLeaf =
  (ctx: Context, limiter: ConcurrencyLimiter): Leaf =>
  (entries) =>
    limiter.run(async () => {
      const { id } = await serializeAndHash(ctx, { type: 'tree', id: '' as ObjectId, entries });
      return (await presentIn(ctx, id)) ? id : undefined;
    });

/** The earlier oid a node falls back on, kept only while its object is still stored. */
type Stale = (id: ObjectId | undefined) => Promise<ObjectId | undefined>;

const staleWhenStored = (
  ctx: Context,
  limiter: ConcurrencyLimiter,
  present: Set<ObjectId>,
): Stale => {
  const probed = new Map<ObjectId, Promise<boolean>>();
  const stored = (id: ObjectId): Promise<boolean> => {
    if (present.has(id)) return Promise.resolve(true);
    const known = probed.get(id) ?? limiter.run(() => presentIn(ctx, id));
    probed.set(id, known);
    return known;
  };
  return async (id) => (id !== undefined && (await stored(id)) ? id : undefined);
};

interface Strategy {
  readonly leaf: Leaf;
  readonly stale?: Stale;
}

/** `ids` are the oids the cache-tree records; `working` also holds the stale ones a parent is hashed over. */
interface Built {
  readonly ids: Ids;
  readonly working: Ids;
}

const buildLevel = async (
  ctx: Context,
  plan: CacheTreePlan,
  layout: Layout,
  level: ReadonlyArray<TreeBuild>,
  built: Built,
  strategy: Strategy,
): Promise<void> => {
  await Promise.all(
    level.map(async (build) => {
      const prefix = layout.prefix[build.node] as number;
      const entries = treeEntriesOf(ctx, plan, build, prefix, built.working);
      const hashed = entries === undefined ? undefined : await strategy.leaf(entries);
      const overStale = build.subtrees.some((child) => built.ids[child] === undefined);
      built.ids[build.node] = overStale ? undefined : hashed;
      built.working[build.node] =
        hashed ?? (await strategy.stale?.((plan.nodes[build.node] as PlannedNode).previousId));
    }),
  );
};

const buildAll = async (plan: CacheTreePlan, strategy: Strategy, ctx: Context): Promise<Built> => {
  const built: Built = {
    ids: plan.nodes.map((node) => node.reused),
    working: plan.nodes.map((node) => node.reused),
  };
  const layout = layoutOf(plan);
  for (const level of levelsDeepestFirst(plan, layout)) {
    await buildLevel(ctx, plan, layout, level, built, strategy);
  }
  return built;
};

export function updateCacheTree(
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  carried: CacheTreeEntry | undefined,
  sink: 'write',
): Promise<WrittenCacheTree>;
export function updateCacheTree(
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  carried: CacheTreeEntry | undefined,
  sink: 'repair',
): Promise<RepairedCacheTree>;
export async function updateCacheTree(
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  carried: CacheTreeEntry | undefined,
  sink: TreeSink,
): Promise<WrittenCacheTree | RepairedCacheTree> {
  const limiter = limiterFor(ctx, 'ioBound');
  const { plan, present } = await settlePlan(ctx, limiter, entries, carried);
  if (sink === 'write') await assertReusedRootIsTree(ctx, plan);
  if (sink === 'repair') {
    const strategy = {
      leaf: hashLeaf(ctx, limiter),
      stale: staleWhenStored(ctx, limiter, present),
    };
    const { ids, working } = await buildAll(plan, strategy, ctx);
    return { cacheTree: toRepairedCacheTree(plan, ids, working, carried) };
  }
  const { ids } = await buildAll(plan, { leaf: writeLeaf(ctx, limiter) }, ctx);
  return { cacheTree: toCacheTreeEntry(plan, ids), rootTree: ids[ROOT] as ObjectId };
}

const flatten = (root: CacheTreeEntry): CacheTreeEntry[] => {
  const nodes: CacheTreeEntry[] = [];
  const pending = [root];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    nodes.push(next);
    pending.push(...next.children);
  }
  return nodes;
};

/** True when every node carries a valid count and its object exists. */
export const isCacheTreeFullyValid = async (
  ctx: Context,
  root: CacheTreeEntry | undefined,
): Promise<boolean> => {
  if (root === undefined) return false;
  const nodes = flatten(root);
  if (nodes.some((node) => node.entryCount < 0 || node.id === undefined)) return false;
  const limiter = limiterFor(ctx, 'ioBound');
  const found = await Promise.all(
    nodes.map((node) => limiter.run(() => presentIn(ctx, node.id as ObjectId))),
  );
  return found.every(Boolean);
};
