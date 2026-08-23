/**
 * Tier-1 `packRefs` command — git's `pack-refs --all`, always. Packs every
 * ref this Context can see into the backend's most-compact on-disk form and
 * removes whatever the packing makes redundant: packed loose files on the
 * files backend, orphaned `*.ref` / `*.temp` reftable tables on the other.
 *
 * git removes unreferenced reftable tables only during `pack-refs --all` /
 * `gc`; tsgit has neither `gc` nor `prune`, so a crash between writing a
 * merged table and swapping `tables.list` would otherwise leak that file
 * forever. Cleanup lives here — the same place and the same moment git
 * performs it — so tsgit is faithful in mechanism and location, not merely
 * in effect. `packRefs` packs refs; it deletes no objects, so
 * `extensions.preciousObjects` is unaffected and still honoured by
 * construction.
 *
 * Both backends' behaviour lives behind the `RefStore` seam as a verb of
 * its own — this command is a thin composition over it, never a backend
 * branch.
 *
 * @writes
 *   surface: packRefs
 *   kind:    equivalent-under-readback
 *   format:  git-packed-refs-state
 */
import type { Context } from '../../ports/context.js';
import { getRefStore, type PackRefsOutcome } from '../primitives/ref-store.js';
import { assertOperationalRepository } from './internal/repo-state.js';

export type PackRefsResult = PackRefsOutcome;

export const packRefs = async (ctx: Context): Promise<PackRefsResult> => {
  await assertOperationalRepository(ctx);
  return getRefStore(ctx).packRefs();
};
