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
 * Deliberately WITHOUT a catch of its own, and no caller may add one: an
 * environmental fault raised here (an unreadable fanout directory, an
 * aborted signal) means the check never ran, and reporting a check that
 * never ran as a passed one is the one answer that must not be given.
 */
export async function objectIsPresent(ctx: Context, id: ObjectId): Promise<boolean> {
  if (await probeLooseOid(ctx, id)) return true;
  return (await getPackRegistry(ctx).lookup(id)) !== undefined;
}
