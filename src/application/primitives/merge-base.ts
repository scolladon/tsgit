import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';

const advanceFrontier = async (
  ctx: Context,
  frontier: ObjectId[],
  visited: Set<ObjectId>,
): Promise<boolean> => {
  if (frontier.length === 0) return false;
  const next: ObjectId[] = [];
  for (const id of frontier) {
    const obj = await readObject(ctx, id);
    if (obj.type !== 'commit') continue;
    for (const parent of obj.data.parents) {
      if (!visited.has(parent)) {
        visited.add(parent);
        next.push(parent);
      }
    }
  }
  frontier.length = 0;
  for (const id of next) frontier.push(id);
  return frontier.length > 0;
};

const intersection = (a: Set<ObjectId>, b: Set<ObjectId>): ObjectId[] => {
  const out: ObjectId[] = [];
  for (const id of a) {
    if (b.has(id)) out.push(id);
  }
  return out;
};

/**
 * Compute a merge base — the first commit reachable from BOTH `a` and `b`.
 *
 * Algorithm: bidirectional BFS with two visited sets. After each layer
 * advance, check the intersection. When non-empty, return the
 * lexicographically smallest oid (deterministic tie-breaker).
 *
 * Returns `undefined` for unrelated histories. Documented limitation: cherry-picks
 * and criss-cross merges may yield non-optimal bases — `recursive`-strategy
 * multi-base resolution is v2.
 */
export const mergeBase = async (
  ctx: Context,
  a: ObjectId,
  b: ObjectId,
): Promise<ObjectId | undefined> => {
  if (a === b) return a;
  const visitedA = new Set<ObjectId>([a]);
  const visitedB = new Set<ObjectId>([b]);
  const frontierA: ObjectId[] = [a];
  const frontierB: ObjectId[] = [b];

  // Check seed overlap before walking.
  const seedHit = intersection(visitedA, visitedB);
  if (seedHit.length > 0) return [...seedHit].sort()[0];

  while (frontierA.length > 0 || frontierB.length > 0) {
    const stepA = await advanceFrontier(ctx, frontierA, visitedA);
    const stepB = await advanceFrontier(ctx, frontierB, visitedB);
    const hit = intersection(visitedA, visitedB);
    if (hit.length > 0) return [...hit].sort()[0];
    if (!stepA && !stepB) break;
  }
  return undefined;
};
