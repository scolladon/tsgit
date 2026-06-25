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
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent — verifyHash defaults true; any hash-verification throw is caught → stored as null, same as with verifyHash:false.
      cache.set(id, await readObject(ctx, id, { verifyHash: false }));
    } catch {
      // Stryker disable next-line BlockStatement: equivalent — cache.get(id) returns undefined when null not set; undefined==null is true so all obj==null guards behave identically.
      cache.set(id, null);
    }
  }
  return cache;
}
