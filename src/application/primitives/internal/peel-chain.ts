/**
 * Shared commit/tag peel loop, used by `read-tree.ts`'s `readTree` (parsed
 * reads) and `diff-trees.ts`'s `peelToTree` (raw reads): both walk a
 * commit/tag chain down to its terminal object, refusing a chain deeper than
 * `MAX_PEEL_DEPTH` — the only difference between the two is the object
 * representation each reads and how each extracts the next hop's id from a
 * commit/tag result. This loop owns the shared depth guard; `nextHop` owns
 * the per-representation read-result dispatch (positive `result.type ===`
 * checks, so each caller's own discriminated union narrows normally at its
 * own call site — no cast needed).
 */

import type { ObjectId } from '../../../domain/objects/index.js';
import { refChainTooDeep } from '../../../domain/refs/error.js';
import type { Context } from '../../../ports/context.js';
import { exceedsMaxPeelDepth } from '../validators.js';

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
  let depth = 0;
  for (;;) {
    const next = nextHop(result, currentId);
    if (next === undefined) return { id: currentId, result };
    depth += 1;
    if (exceedsMaxPeelDepth(depth)) throw refChainTooDeep(depth, []);
    currentId = next;
    result = await read(ctx, currentId);
  }
}
