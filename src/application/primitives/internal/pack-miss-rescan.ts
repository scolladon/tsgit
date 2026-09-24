/**
 * Re-scan-once on a full object miss — git's own `reprepare_packed_git`
 * retry (`odb.c`/`object-file.c`: `oid_object_info_extended` calls it and
 * retries exactly once when an object is found nowhere). Every arm that
 * classifies "no pack claims this id AND no loose file exists for it" as a
 * miss (the buffered resolver, `hasObject`, the streamed blob source) shares
 * this single choke point: it refreshes the pack registry's `.idx` scan and
 * drops the loose fanout listing, then the CALLER re-runs its own lookup —
 * this module never retries by itself.
 *
 * Single-flighted per session: N concurrent misses (for the same id, or
 * different ids) join ONE re-scan rather than each starting its own. The
 * in-flight promise is dropped from the map once it settles, so the NEXT
 * wave of misses — after every joiner of this one has already retried —
 * pays its own fresh re-scan, matching git's unconditional per-miss retry
 * rather than caching "still missing" forever.
 */
import type { Context } from '../../../ports/context.js';
import type { PackRegistry } from '../pack-registry.js';
import { forgetAllLooseOid } from './loose-oid-cache.js';

const pendingRescanBySession = new WeakMap<Context['session'], Promise<void>>();

export function rescanOnFullMiss(ctx: Context, registry: PackRegistry): Promise<void> {
  const existing = pendingRescanBySession.get(ctx.session);
  if (existing !== undefined) return existing;
  const pending = Promise.resolve()
    .then(() => {
      registry.refresh();
      forgetAllLooseOid(ctx);
    })
    .finally(() => {
      if (pendingRescanBySession.get(ctx.session) === pending) {
        pendingRescanBySession.delete(ctx.session);
      }
    });
  pendingRescanBySession.set(ctx.session, pending);
  return pending;
}
