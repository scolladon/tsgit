import type { ObjectId } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { probeLooseOid } from '../../../primitives/internal/loose-oid-cache.js';
import { getPackRegistry } from '../../../primitives/read-object.js';

/**
 * Whether `id` genuinely exists and is accessible — one loose-then-pack
 * existence probe, defined once for every pass that needs it (the
 * cache-tree check in `roots.ts`, the ref-target confirmation in
 * `refs-verify.ts`). Never reads the object's own bytes: `probeLooseOid` is
 * a cached presence check and `registry.lookup` stops at the pack's own
 * header gate, the same structural probe `health()` performs.
 *
 * Deliberately INDEPENDENT of `universe` membership: `universe` is narrowed
 * for reasons that have nothing to do with object health (`full: false`
 * excludes packs outright as a scan-depth choice; `connectivityOnly` widens
 * it to admit an oid whose housing pack later fails its own header gate).
 * Measured against git 2.55.0: git's own cache-tree check is never gated by
 * `--no-full` or `--connectivity-only` either — a chmod'd pack still fails
 * it under `--no-full`, and a healthy one still passes it.
 *
 * Deliberately WITHOUT a catch of its own: an environmental fault raised
 * here (an unreadable fanout directory, an aborted signal) means the check
 * never ran, and reporting a check that never ran as a passed one is the one
 * answer that must not be given.
 *
 * A caller may contain a fault only where it names a broken ROUTE rather
 * than a missing object, AND the same run already reports that fault under
 * its own exit bit — the cache-tree walk contains exactly one such code,
 * answering "cannot say" rather than "absent". Containing anything else, or
 * containing it silently, re-creates the swallow this function exists to
 * prevent.
 *
 * That second condition is a fact rather than a hope only because of pass
 * ORDER: `runMidxHealthPass` has already walked every midx entry and settled
 * its verdict by the time `collectRoots` drives this probe, so a routing that
 * refuses THIS oid is already recorded as a finding when the walk contains
 * it. Reorder the two and the cache-tree walk would be containing a fault
 * against a report not yet made. `refs-verify.ts` deliberately contains
 * nothing for exactly that reason — it runs AHEAD of the midx pass — which is
 * why the same fault class aborts the run through a ref target and is
 * contained through a cache-tree entry.
 */
export async function objectIsPresent(ctx: Context, id: ObjectId): Promise<boolean> {
  if (await probeLooseOid(ctx, id)) return true;
  return (await getPackRegistry(ctx).lookup(id)) !== undefined;
}
