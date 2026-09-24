/**
 * Local-only object-presence probe. A CQS query: unlike `readObject`, it never
 * inflates, never verifies, and never consults `ctx.promisor` — a promised
 * (not-yet-fetched) object in a partial repo answers `false` here, exactly as
 * it would on disk. Callers that need the object's bytes still go through
 * `readObject`.
 */
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { probeLooseOid } from './internal/loose-oid-cache.js';
import type { PackRegistry } from './pack-registry.js';
import { getPackRegistry, peekPackRegistry } from './read-object.js';

/**
 * A quick probe, as git's `has_object` is by default: a miss is an ordinary
 * answer here (negotiation walks absent haves routinely), so it never
 * re-scans the pack directory the way a content read does.
 */
export const hasObject = async (ctx: Context, id: ObjectId): Promise<boolean> => {
  const registry: PackRegistry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  const hit = await registry.lookup(id);
  if (hit !== undefined) return true;
  return probeLooseOid(ctx, id);
};
