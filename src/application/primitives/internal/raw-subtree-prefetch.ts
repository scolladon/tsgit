/**
 * Kicks off bounded-concurrency reads for DIRECTORY child entries at the
 * FRONT of one tree level, ahead of the (unchanged) sequential per-entry
 * descent in `flatten-raw.ts` and `walk-raw-subtree.ts`. This is a pure
 * prefetch of CONTENT: DFS pre-order is observable (git's `diff-tree -r`
 * order) and stays governed entirely by each walker's own per-entry loop —
 * this module never processes an entry itself, never validates a name,
 * never touches the entry counter or abort signal.
 *
 * Runs its own cursor pass over the SAME content bytes the caller's main
 * loop will scan a second time — a re-scan (a hex oid string is allocated
 * per prefetched child, see `cursorOid`) traded for overlapping the
 * expensive part (child object I/O) across siblings, bounded by a limiter
 * SHARED across the whole walk (see `concurrency-limiter.ts`).
 *
 * The prescan is deliberately bounded on TWO axes, so a pathologically wide
 * or malformed level can never defeat the main loop's own containment:
 *
 * - WINDOWED: it stops enqueueing once the map reaches `PRESCAN_WINDOW`
 *   entries (or the caller's remaining entry budget, if smaller) — a level
 *   with more directory children than that scans past the window without
 *   enqueueing the rest. The window doubles as the bound on the prefetch's
 *   own FIFO backlog: capping how many reads can queue behind the shared
 *   limiter before any of them is even awaited also bounds how far a
 *   low-priority child can be pushed behind its siblings by a wide level
 *   elsewhere in the walk (priority inversion). An id beyond the window is
 *   simply never prefetched — the per-descent `?? readRawObject` fallback
 *   in both callers reads it directly when the main loop reaches it.
 * - TOLERANT: a structurally malformed entry stops the scan rather than
 *   throwing. The main loop's OWN cursor scan re-encounters the identical
 *   byte offset and throws the identical error, at the point the
 *   un-prefetched code path was always going to throw it — this is not
 *   error swallowing, just deferring the throw to where it belongs, so an
 *   earlier per-entry guard (abort signal, entry cap) in the main loop still
 *   fires before a LATER structural defect ever gets a chance to.
 *
 * A prefetch a walker never reaches — because an earlier sibling threw first
 * — must not surface its own rejection as an unhandled one: `.catch` is
 * attached at creation so Node marks the promise handled, while the SAME
 * promise, stored in the returned map, still carries the original rejection
 * for whoever later awaits it.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import { advanceCursor, cursorOid, openTreeCursor } from '../../../domain/objects/tree-cursor.js';
import type { Context } from '../../../ports/context.js';
import { readRawObject } from '../read-object.js';
import type { RawObject } from '../types.js';
import { MAX_CONCURRENT_OBJECT_LOADS } from './bounded-map.js';
import type { ConcurrencyLimiter } from './concurrency-limiter.js';

export type SubtreePrefetch = ReadonlyMap<ObjectId, Promise<RawObject>>;

// A small multiple of the shared concurrency cap: wide enough that the
// limiter itself, not this window, is normally the binding constraint.
const PRESCAN_WINDOW = MAX_CONCURRENT_OBJECT_LOADS * 2;

export function prefetchSubtreeChildren(
  ctx: Context,
  content: Uint8Array,
  limiter: ConcurrencyLimiter,
  remainingEntries?: number,
): SubtreePrefetch {
  const prefetch = new Map<ObjectId, Promise<RawObject>>();
  const window = prescanWindow(remainingEntries);
  try {
    scanForPrefetch(ctx, content, limiter, prefetch, window);
  } catch {
    // Deliberately swallowed here — see the TOLERANT bullet above: the main
    // loop's own scan re-throws the identical error at the identical offset.
  }
  return prefetch;
}

function prescanWindow(remainingEntries: number | undefined): number {
  return remainingEntries === undefined
    ? PRESCAN_WINDOW
    : Math.min(PRESCAN_WINDOW, remainingEntries);
}

function scanForPrefetch(
  ctx: Context,
  content: Uint8Array,
  limiter: ConcurrencyLimiter,
  prefetch: Map<ObjectId, Promise<RawObject>>,
  window: number,
): void {
  const cursor = openTreeCursor(content, ctx.hashConfig);
  while (!cursor.done && prefetch.size < window) {
    if (cursor.isDir) startPrefetch(ctx, limiter, prefetch, cursorOid(cursor));
    advanceCursor(cursor);
  }
}

function startPrefetch(
  ctx: Context,
  limiter: ConcurrencyLimiter,
  prefetch: Map<ObjectId, Promise<RawObject>>,
  childId: ObjectId,
): void {
  // Two sibling directory entries content-addressing to the same oid share
  // one read rather than paying for it twice.
  if (prefetch.has(childId)) return;
  const read = limiter.run(() => readRawObject(ctx, childId));
  read.catch(() => {});
  prefetch.set(childId, read);
}
