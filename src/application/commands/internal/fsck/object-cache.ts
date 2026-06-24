import type { GitObject, ObjectId } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { readObject } from '../../../primitives/read-object.js';

// ---------------------------------------------------------------------------
// Object cache — read every universe object exactly once (no hash verification
// here; hash correctness is checked separately in the content-validation pass
// from the raw bytes that pass already reads).
// ---------------------------------------------------------------------------

/** null = unreadable / corrupt object */
export type CachedGitObject = GitObject | null;

/**
 * Build a map of all universe OIDs to their parsed GitObject (or null when
 * the object cannot be read). Every later pass consumes this map instead of
 * issuing redundant readObject calls.
 */
export async function buildObjectCache(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
): Promise<ReadonlyMap<ObjectId, CachedGitObject>> {
  const cache = new Map<ObjectId, CachedGitObject>();
  for (const id of universe) {
    try {
      cache.set(id, await readObject(ctx, id, { verifyHash: false }));
    } catch {
      cache.set(id, null);
    }
  }
  return cache;
}
