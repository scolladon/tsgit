/**
 * Kicks off bounded-concurrency reads for every DIRECTORY child entry at one
 * tree level, ahead of the (unchanged) sequential per-entry descent in
 * `flatten-raw.ts` and `walk-raw-subtree.ts`. This is a pure prefetch of
 * CONTENT: DFS pre-order is observable (git's `diff-tree -r` order) and
 * stays governed entirely by each walker's own per-entry loop — this module
 * never processes an entry itself, never validates a name, never touches the
 * entry counter or abort signal.
 *
 * Runs its own cursor pass over the SAME content bytes the caller's main
 * loop will scan a second time — a cheap, zero-copy re-scan traded for
 * overlapping the expensive part (child object I/O) across siblings, bounded
 * by a limiter SHARED across the whole walk (see `concurrency-limiter.ts`).
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
import type { ConcurrencyLimiter } from './concurrency-limiter.js';

export type SubtreePrefetch = ReadonlyMap<ObjectId, Promise<RawObject>>;

export function prefetchSubtreeChildren(
  ctx: Context,
  content: Uint8Array,
  limiter: ConcurrencyLimiter,
): SubtreePrefetch {
  const prefetch = new Map<ObjectId, Promise<RawObject>>();
  const cursor = openTreeCursor(content, ctx.hashConfig);
  while (!cursor.done) {
    if (cursor.isDir) startPrefetch(ctx, limiter, prefetch, cursorOid(cursor));
    advanceCursor(cursor);
  }
  return prefetch;
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
