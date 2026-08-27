/**
 * Resolve HEAD's commit tree as a `FlatTree` (`path → { id, mode }`), or
 * `undefined` for an unborn HEAD (no commits yet). This is git's HEAD-tree side
 * of `diff-index` — the staged column compares it against the index.
 *
 * Tolerates an unborn HEAD by catching `REF_NOT_FOUND` (the symbolic ref points
 * at a branch with no commit). A HEAD that resolves to a non-commit object is a
 * corrupt repository and throws `unexpectedObjectType`.
 *
 * Pure with respect to the working tree — only reads git objects (via
 * `resolveRef` / `readObject` / `flattenTree`).
 *
 * Result is memoised behind a byte-capped `LruCache` keyed `(rootTreeOid,
 * maxDepth)` — trees are immutable, so re-reading the same HEAD under the
 * same `core.maxTreeDepth` never needs a fresh descent.
 */
import type { FlatTree } from '../../domain/diff/flat-tree.js';
import { TsgitError } from '../../domain/error.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { createLruCache, type LruCache } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { flattenTree } from './flatten-tree.js';
import { resolveFlattenBounds } from './internal/flatten-raw.js';
import { deltaBaseCachingEnabled } from './object-resolver.js';
import { readObject } from './read-object.js';
import { resolveRef } from './resolve-ref.js';

/**
 * Keyed on `ctx.session` — not `ctx` itself — mirroring
 * `object-resolver.ts`'s `parsedObjectMemos`: every `Context` derived from
 * the same `openRepository()`/`createXContext()` call shares the session, so
 * the cache survives every spread-derivation this codebase does instead of
 * missing on every fresh spread.
 *
 * Gated by {@link deltaBaseCachingEnabled}, the same object-byte-cache
 * enablement check `object-resolver.ts` uses: fsck's audit Context shares
 * the session but carries a zero-budget `deltaCache`, and a flattened tree
 * is derived from object bytes, so it must not be served from — or written
 * into — a memo the audit shares with the opening Context.
 */
const flatTreeCaches = new WeakMap<Context['session'], LruCache<FlatTree>>();

/**
 * Share of `ctx.deltaCache`'s own byte budget this cache gets, as an
 * independent allocation — mirrors `object-resolver.ts`'s
 * `PARSED_OBJECT_MEMO_FRACTION`: the two caches hold different things and
 * compete only for process memory, not a shared accounting ledger.
 */
const FLAT_TREE_CACHE_FRACTION = 0.0625;

function flatTreeCacheFor(ctx: Context): LruCache<FlatTree> | undefined {
  if (!deltaBaseCachingEnabled(ctx)) return undefined;
  const existing = flatTreeCaches.get(ctx.session);
  if (existing !== undefined) return existing;
  const created = createLruCache<FlatTree>(ctx.deltaCache.maxSize * FLAT_TREE_CACHE_FRACTION);
  flatTreeCaches.set(ctx.session, created);
  return created;
}

/**
 * `maxDepth` is IN the key: `resolveFlattenBounds` re-resolves
 * `core.maxTreeDepth` on every call, so a `FlatTree` cached under one depth
 * is not valid under another — keying on the oid alone would silently alias
 * a tree built under a stale depth. That makes correctness across a
 * `core.maxTreeDepth` change structural, with no config-invalidation
 * coupling needed.
 */
function flatTreeCacheKey(rootTreeOid: ObjectId, maxDepth: number): string {
  return `${rootTreeOid}:${maxDepth}`;
}

/**
 * Approximate retained footprint of a `FlatTree`: path length plus oid
 * length per entry (mirrors `parsedObjectByteSize`'s string-length proxy for
 * a value's heap cost). Floored at 1: `LruCache.set` throws on
 * `byteSize <= 0`, and a genuinely empty tree (HEAD at the empty-tree commit)
 * is still worth caching.
 */
function flatTreeByteSize(tree: FlatTree): number {
  let total = 0;
  for (const [path, entry] of tree.entries) {
    total += path.length + entry.id.length;
  }
  return Math.max(1, total);
}

export const readHeadTree = async (ctx: Context): Promise<FlatTree | undefined> => {
  const commitId = await resolveRef(ctx, 'HEAD').catch((err: unknown) => {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') return undefined;
    throw err;
  });
  if (commitId === undefined) return undefined;
  const commit = await readObject(ctx, commitId);
  if (commit.type !== 'commit') {
    throw unexpectedObjectType('commit', commit.type, commitId);
  }
  const { maxDepth } = await resolveFlattenBounds(ctx);
  const cache = flatTreeCacheFor(ctx);
  const key = flatTreeCacheKey(commit.data.tree, maxDepth);
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;
  const tree = await flattenTree(ctx, commit.data.tree);
  cache?.set(key, tree, flatTreeByteSize(tree));
  return tree;
};
