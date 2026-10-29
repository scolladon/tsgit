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
import { ownerUnavailableHit } from './object-resolver.js';
import {
  getObjectStore,
  looseCacheLocation,
  type ObjectStore,
  peekObjectStore,
} from './object-store.js';

/** Whether a miss re-scans the pack directory before answering — see {@link hasObject}. */
export type HasObjectMode = 'quick' | 'recheck';

/** `hasObject`'s one option: the probe {@link HasObjectMode}. */
export interface HasObjectOptions {
  readonly mode: HasObjectMode;
}

const QUICK: HasObjectOptions = { mode: 'quick' };

async function probeOnce(ctx: Context, store: ObjectStore, id: ObjectId): Promise<boolean> {
  for (const source of store.sources) {
    if ((await source.registry.lookup(id)) !== undefined) return true;
    if (await probeLooseOid(ctx, id, looseCacheLocation(store, source))) return true;
  }
  return false;
}

/**
 * `options.mode`'s `'quick'` (the default) never re-scans the pack directory
 * on a miss — git's `has_object` posture by default, since negotiation walks
 * absent haves routinely. `'recheck'` goes through the SAME one-retry
 * re-scan a content read pays on a full miss (git's `odb_has_object(...,
 * HAS_OBJECT_RECHECK_PACKED)`), for a caller that must not answer "absent"
 * for an object a concurrent writer (a lazy fetch, an external `git
 * repack`) already put on disk since the registry last scanned.
 */
export const hasObject = async (
  ctx: Context,
  id: ObjectId,
  options: HasObjectOptions = QUICK,
): Promise<boolean> => {
  const store = peekObjectStore(ctx) ?? (await getObjectStore(ctx));
  if (await probeOnce(ctx, store, id)) return true;
  if (options.mode === 'quick') return false;
  const retried = await retryOnceAfterRescan(ctx, store, id, async () =>
    (await probeOnce(ctx, store, id)) || (await ownerUnavailableHit(store, id)) !== undefined
      ? true
      : undefined,
  );
  return retried ?? false;
};
