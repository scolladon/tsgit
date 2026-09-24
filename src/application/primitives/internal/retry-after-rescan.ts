/**
 * The full-object-miss retry every content-read arm shares: `readObject`'s
 * buffered resolver (`object-resolver.ts`) and the streamed blob source
 * (`blob-source.ts`) both classify "no pack claims this id AND no loose file
 * exists for it" as a miss, re-scan once (`rescanOnFullMiss`), and retry
 * their own lookup exactly once. Extracted so both share ONE re-scan +
 * abort-check sequence rather than drifting — a prior version had the abort
 * check immediately after the re-scan in one file but not the other (each
 * still honoured an abort eventually, through its own inner check, just at
 * a different point).
 */
import { operationAborted } from '../../../domain/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import type { PackRegistry } from '../pack-registry.js';
import { rescanOnFullMiss } from './pack-miss-rescan.js';

export function checkAborted(ctx: Context): void {
  if (ctx.signal?.aborted === true) {
    throw operationAborted();
  }
}

/**
 * Re-scans once (`rescanOnFullMiss`), honours an abort raised during it, then
 * runs `attempt` — the caller's own single retry of its lookup. `undefined`
 * means still missing after the retry; the caller converts that into its own
 * `OBJECT_NOT_FOUND`.
 */
export async function retryOnceAfterRescan<T>(
  ctx: Context,
  registry: PackRegistry,
  missedId: ObjectId,
  attempt: () => Promise<T | undefined>,
): Promise<T | undefined> {
  await rescanOnFullMiss(ctx, registry, missedId);
  checkAborted(ctx);
  return attempt();
}
