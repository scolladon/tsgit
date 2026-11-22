import { readRawIndex } from '../../application/primitives/read-index.js';
import type { IndexResolver } from '../../ports/snapshot-resolvers.js';

/**
 * Stateless `IndexResolver` adapter. Delegates to `readRawIndex` (the parse
 * with every stored skip-worktree bit intact) on every call — no caching, no inflight de-duplication. The
 * `ResolveOptions.bypassCache` flag is accepted (port contract) but
 * ignored here, since there is no cache to bypass.
 *
 * This is the bottom of the resolver decorator stack.
 * Caching and single-flight adapters wrap this; the freshness checks
 * (size limit, SHA-1 trailer verification) live inside `readRawIndex` and
 * therefore apply to every uncached read. The present-file clear is applied
 * above the cache by the clearing resolver.
 */
export const createRawIndexResolver = (): IndexResolver => ({
  resolve: (ctx) => readRawIndex(ctx),
});
