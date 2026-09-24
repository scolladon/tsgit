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
import { rescanOnFullMiss } from './internal/pack-miss-rescan.js';
import type { PackRegistry } from './pack-registry.js';
import { getPackRegistry, peekPackRegistry } from './read-object.js';

async function probeOnce(ctx: Context, registry: PackRegistry, id: ObjectId): Promise<boolean> {
  const hit = await registry.lookup(id);
  if (hit !== undefined) return true;
  return probeLooseOid(ctx, id);
}

export const hasObject = async (ctx: Context, id: ObjectId): Promise<boolean> => {
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  if (await probeOnce(ctx, registry, id)) return true;
  // Full miss: as of the CURRENT generation, neither a pack nor the loose
  // store claims `id` — re-scan once (git's `reprepare_packed_git` retry)
  // and probe again. Many concurrent misses share ONE re-scan.
  await rescanOnFullMiss(ctx, registry);
  return probeOnce(ctx, registry, id);
};
