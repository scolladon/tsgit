import type { GitIndex } from '../../domain/git-index/index-entry.js';
import type { Context } from '../../ports/context.js';
import type { IndexResolver, ResolveOptions } from '../../ports/snapshot-resolvers.js';

/**
 * Wraps an `IndexResolver` so that any number of concurrent `resolve()`
 * calls share a single in-flight promise from the inner resolver. As soon
 * as the inner settles (fulfilled or rejected), the in-flight slot is
 * cleared so the next caller triggers a fresh resolve.
 *
 * Why: with `CachingIndexResolver` underneath, a thundering herd of
 * concurrent readers would otherwise each pay the parse cost during the
 * cache-warm window. De-duplicating to one inner call is the standard
 * single-flight idiom (see design §10.3).
 *
 * `bypassCache` opts out of the dedup gate entirely. A caller that asks to
 * skip the cache wants a fresh parse — joining an already-in-flight
 * non-bypass promise would silently return the (potentially stale) cached
 * result, defeating the bypass guarantee.
 */
export const createSingleFlightIndexResolver = (inner: IndexResolver): IndexResolver => {
  let inflight: Promise<GitIndex> | null = null;

  const run = (ctx: Context, opts?: ResolveOptions): Promise<GitIndex> => {
    const pending = inner.resolve(ctx, opts).finally(() => {
      inflight = null;
    });
    inflight = pending;
    return pending;
  };

  return {
    resolve: (ctx, opts) => {
      if (opts?.bypassCache === true) return inner.resolve(ctx, opts);
      return inflight ?? run(ctx, opts);
    },
  };
};
