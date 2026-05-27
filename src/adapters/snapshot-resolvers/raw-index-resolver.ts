import { readIndex } from '../../application/primitives/read-index.js';
import type { IndexResolver } from '../../ports/snapshot-resolvers.js';

/**
 * Stateless `IndexResolver` adapter. Delegates to the existing `readIndex`
 * primitive on every call — no caching, no inflight de-duplication. The
 * `ResolveOptions.bypassCache` flag is accepted (port contract) but
 * ignored here, since there is no cache to bypass.
 *
 * This is the bottom of the resolver decorator stack (see design §10.1).
 * Caching and single-flight adapters wrap this; the freshness checks
 * (size limit, SHA-1 trailer verification) live inside `readIndex` and
 * therefore apply to every uncached read.
 */
export const createRawIndexResolver = (): IndexResolver => ({
  resolve: (ctx) => readIndex(ctx),
});
