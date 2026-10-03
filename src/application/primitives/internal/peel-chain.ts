/**
 * Shared commit/tag peel loop, used by `read-tree.ts`'s `readTree` (parsed
 * reads) and `diff-trees.ts`'s `peelToTree` (raw reads): both walk a
 * commit/tag chain down to its terminal object, to any depth as git does,
 * refusing only a chain that revisits an object — which only a store whose
 * objects do not hash to their names can hold. The only difference between
 * the two callers is the object
 * representation each reads and how each extracts the next hop's id from a
 * commit/tag result. This loop owns the shared revisit guard; `nextHop` owns
 * the per-representation read-result dispatch (positive `result.type ===`
 * checks, so each caller's own discriminated union narrows normally at its
 * own call site — no cast needed).
 */

import type { ObjectId } from '../../../domain/objects/index.js';
import { refChainTooDeep } from '../../../domain/refs/error.js';
import type { Context } from '../../../ports/context.js';

export interface PeelOutcome<T> {
  readonly id: ObjectId;
  readonly result: T;
}

export async function peelChain<T extends { readonly type: string }>(
  ctx: Context,
  startId: ObjectId,
  read: (ctx: Context, id: ObjectId) => Promise<T>,
  nextHop: (result: T, currentId: ObjectId) => ObjectId | undefined,
): Promise<PeelOutcome<T>> {
  let currentId = startId;
  let result = await read(ctx, currentId);
  const seen = new Set<ObjectId>([startId]);
  for (;;) {
    const next = nextHop(result, currentId);
    if (next === undefined) return { id: currentId, result };
    if (seen.has(next)) throw refChainTooDeep(seen.size, []);
    seen.add(next);
    currentId = next;
    result = await read(ctx, currentId);
  }
}
