/**
 * Re-scan-once on a full object miss — git's own `reprepare_packed_git`
 * retry (`odb.c`/`object-file.c`: `oid_object_info_extended` calls it and
 * retries exactly once when an object is found nowhere). Every arm that
 * classifies "no pack claims this id AND no loose file exists for it" as a
 * miss (the buffered resolver, `hasObject`, the streamed blob source) shares
 * this single choke point: it re-lists the pack directory (`registry.
 * reprepare()` — INCREMENTAL, unlike `refresh()`: known packs, their `.idx`
 * memos, their handles and their window-cache entries all survive; only new
 * packs are added and vanished ones retired) and drops the missed id's own
 * loose fanout listing, then the CALLER re-runs its own lookup — this
 * module never retries by itself.
 *
 * Single-flighted per session: N concurrent misses (for the same id, or
 * different ids) join ONE re-scan rather than each starting its own. Every
 * id that joins the current wave is recorded, so the wave's own re-scan
 * forgets each of THEIR fanout prefixes — not the whole session's loose
 * cache — once it actually runs. The in-flight promise is dropped from the
 * map once it settles, so the NEXT wave of misses — after every joiner of
 * this one has already retried — pays its own fresh re-scan, matching git's
 * unconditional per-miss retry rather than caching "still missing" forever.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import type { PackRegistry } from '../pack-registry.js';
import { forgetLooseOidPrefix } from './loose-oid-cache.js';

interface PendingRescan {
  readonly promise: Promise<void>;
  /** Every id that joined this wave before its re-scan ran — the loose
   *  fanout prefixes the re-scan must forget once it settles. */
  readonly missedIds: Set<ObjectId>;
}

const pendingRescanBySession = new WeakMap<Context['session'], PendingRescan>();

export function rescanOnFullMiss(
  ctx: Context,
  registry: PackRegistry,
  missedId: ObjectId,
): Promise<void> {
  const existing = pendingRescanBySession.get(ctx.session);
  if (existing !== undefined) {
    existing.missedIds.add(missedId);
    return existing.promise;
  }
  const missedIds = new Set<ObjectId>([missedId]);
  const dropSessionEntry = (): void => {
    if (pendingRescanBySession.get(ctx.session)?.promise === promise) {
      pendingRescanBySession.delete(ctx.session);
    }
  };
  const promise = registry
    .reprepare()
    .then(() => {
      // Drop the session entry BEFORE walking `missedIds` — not only in
      // `.finally` below, once every id is already forgotten. A miss that
      // arrives once `reprepare()` has settled but before this callback
      // runs would otherwise still see the (about-to-be-stale) entry, join
      // via `missedIds.add`, and never have ITS OWN prefix forgotten — this
      // wave's forget pass has already walked the set by the time it joins.
      // Removing first means that miss instead starts a fresh wave of its
      // own, which forgets its prefix on its own terms.
      dropSessionEntry();
      for (const id of missedIds) forgetLooseOidPrefix(ctx, id);
    })
    .finally(() => {
      // Safety net for the rejection path only: a rejected reprepare() skips
      // the .then() above entirely, so the entry would otherwise never drop.
      dropSessionEntry();
    });
  pendingRescanBySession.set(ctx.session, { promise, missedIds });
  return promise;
}
