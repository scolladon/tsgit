import { readObject } from '../../application/primitives/read-object.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { TreeResolver } from '../../ports/snapshot-resolvers.js';

/**
 * Stateless `TreeResolver` adapter. Reads the object via `readObject` and
 * rejects anything that is not a tree. No caching, no inflight de-duplication.
 *
 * Unlike the legacy `readTree` primitive, this resolver does NOT peel
 * commits or tags — it only resolves trees by their direct oid. Peeling
 * belongs in higher-level commands (the snapshot factory chooses what to
 * peel before handing an oid to this resolver). The `ResolveOptions`
 * argument is accepted to satisfy the port contract but has no effect
 * here, since there is no cache to bypass.
 */
export const createRawTreeResolver = (): TreeResolver => ({
  resolve: async (ctx, treeId) => {
    const object = await readObject(ctx, treeId);
    if (object.type !== 'tree') {
      throw unexpectedObjectType('tree', object.type, treeId);
    }
    return object;
  },
});
