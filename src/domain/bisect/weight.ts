import type { ObjectId } from '../objects/index.js';
import type { BisectCandidate } from './types.js';

/**
 * Verbatim port of git's `count_distance` from bisect.c.
 *
 * Counts the number of candidates reachable from `startId` through in-set
 * parent edges, including `startId` itself. Multi-parent (merge/octopus)
 * commits union their parent ancestries — the union, not a per-branch sum.
 *
 * @param startId The candidate from which to start counting.
 * @param byId    Lookup map built from the candidate array.
 * @returns       The number of reachable in-set candidates (≥ 1).
 */
export const countDistance = (
  startId: ObjectId,
  byId: ReadonlyMap<ObjectId, BisectCandidate>,
): number => {
  const visited = new Set<ObjectId>();
  const stack: ObjectId[] = [startId];
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId;
    if (visited.has(id)) continue;
    const candidate = byId.get(id);
    if (candidate === undefined) continue;
    visited.add(id);
    for (const parentId of candidate.parents) {
      if (!visited.has(parentId)) {
        stack.push(parentId);
      }
    }
  }
  return visited.size;
};
