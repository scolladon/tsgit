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
import { retryOnceAfterRescan } from './internal/retry-after-rescan.js';
import type { PackRegistry } from './pack-registry.js';
import { getPackRegistry, peekPackRegistry } from './read-object.js';

/**
 * `'quick'` (the default) never re-scans the pack directory on a miss —
 * git's `has_object` posture by default, since negotiation walks absent
 * haves routinely. `'recheck'` goes through the SAME one-retry re-scan a
 * content read pays on a full miss (git's `odb_has_object(...,
 * HAS_OBJECT_RECHECK_PACKED)`), for a caller that must not answer "absent"
 * for an object a concurrent writer (a lazy fetch, an external `git
 * repack`) already put on disk since the registry last scanned.
 */
export type HasObjectMode = 'quick' | 'recheck';

export interface HasObjectOptions {
  readonly mode: HasObjectMode;
}

const QUICK: HasObjectOptions = { mode: 'quick' };

async function probeOnce(ctx: Context, registry: PackRegistry, id: ObjectId): Promise<boolean> {
  const hit = await registry.lookup(id);
  if (hit !== undefined) return true;
  return probeLooseOid(ctx, id);
}

export const hasObject = async (
  ctx: Context,
  id: ObjectId,
  options: HasObjectOptions = QUICK,
): Promise<boolean> => {
  const registry: PackRegistry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  if (await probeOnce(ctx, registry, id)) return true;
  if (options.mode === 'quick') return false;
  const retried = await retryOnceAfterRescan(ctx, registry, id, async () =>
    (await probeOnce(ctx, registry, id)) ? true : undefined,
  );
  return retried ?? false;
};
