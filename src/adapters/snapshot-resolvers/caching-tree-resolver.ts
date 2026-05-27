import type { ObjectId, Tree } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { ResolveOptions, TreeResolver } from '../../ports/snapshot-resolvers.js';

export interface CachingTreeResolverOptions {
  /** Maximum entries retained in the LRU. Default 256. */
  readonly maxSize?: number;
}

const DEFAULT_MAX_SIZE = 256;

/**
 * Bounded LRU cache keyed by tree `ObjectId`. Trees are content-addressed,
 * so the cache never needs invalidation — same oid always maps to the same
 * bytes. Lifts the pack delta-base LRU pattern (object-resolver.ts) into a
 * dedicated tree resolver adapter (design §10.5).
 *
 * Most-recently-used promotion is implemented via Map insertion order:
 * deleting and re-setting the key moves it to the tail; the head is the
 * least-recently-used and is evicted when the cap is exceeded.
 */
export const createCachingTreeResolver = (
  inner: TreeResolver,
  options: CachingTreeResolverOptions = {},
): TreeResolver => {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const cache = new Map<ObjectId, Tree>();

  const resolveAndStore = async (
    ctx: Context,
    treeId: ObjectId,
    opts?: ResolveOptions,
  ): Promise<Tree> => {
    const tree = await inner.resolve(ctx, treeId, opts);
    cache.set(treeId, tree);
    if (cache.size > maxSize) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return tree;
  };

  return {
    resolve: async (ctx, treeId, opts) => {
      if (opts?.bypassCache === true) return resolveAndStore(ctx, treeId, opts);

      const cached = cache.get(treeId);
      if (cached !== undefined) {
        // Re-insert to mark MRU.
        cache.delete(treeId);
        cache.set(treeId, cached);
        return cached;
      }

      return resolveAndStore(ctx, treeId, opts);
    },
  };
};
