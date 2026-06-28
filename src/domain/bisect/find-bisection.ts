import type { ObjectId } from '../objects/index.js';
import type { BisectCandidate, Bisection } from './types.js';
import { countDistance } from './weight.js';

const approxHalfway = (weight: number, all: number): boolean => {
  const diff = 2 * weight - all;
  return diff >= -1 && diff <= 1;
};

type BestResult = { readonly id: ObjectId; readonly weight: number };

/**
 * Pick the candidate that maximises `min(weight, all-weight)`.
 * Strict `>` keeps the EARLIER candidate on a tie (list-order tie-break,
 * faithful to git's `best_bisection`).
 *
 * Caller guarantees `candidates` is non-empty.
 */
const bestBisection = (
  candidates: ReadonlyArray<BisectCandidate>,
  weights: ReadonlyMap<ObjectId, number>,
  all: number,
): BestResult => {
  // Seed from candidates[0] — caller guarantees non-empty (findBisection guards).
  const first = candidates[0]!;
  const firstWeight = weights.get(first.id) as number;
  let bestId = first.id;
  let bestDist = Math.min(firstWeight, all - firstWeight);
  let bestWeight = firstWeight;
  for (let i = 1; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    const w = weights.get(c.id) as number;
    const dist = Math.min(w, all - w);
    if (dist > bestDist) {
      bestDist = dist;
      bestId = c.id;
      bestWeight = w;
    }
  }
  return { id: bestId, weight: bestWeight };
};

const seedWeights = (
  candidates: ReadonlyArray<BisectCandidate>,
  weights: Map<ObjectId, number>,
): void => {
  for (const c of candidates) {
    if (c.parents.length === 0) {
      weights.set(c.id, 1);
    }
  }
};

const mergeWeights = (
  candidates: ReadonlyArray<BisectCandidate>,
  byId: ReadonlyMap<ObjectId, BisectCandidate>,
  weights: Map<ObjectId, number>,
  all: number,
): Bisection | undefined => {
  for (const c of candidates) {
    if (c.parents.length < 2) continue;
    const w = countDistance(c.id, byId);
    weights.set(c.id, w);
    if (approxHalfway(w, all)) {
      return { nextCommit: c.id, candidateCount: all, reaches: w };
    }
  }
  return undefined;
};

/**
 * Try to assign a fill weight to a single-strand candidate.
 * Returns `undefined` when the candidate is not ready (already weighted, not
 * single-strand, or parent not yet weighted). Returns `null` when the weight
 * was assigned but the halfway band was not hit. Returns a `Bisection` when
 * the candidate is in the halfway band (caller should return it immediately).
 */
const tryFillOne = (
  c: BisectCandidate,
  weights: Map<ObjectId, number>,
  all: number,
): Bisection | null | undefined => {
  if (weights.has(c.id) || c.parents.length !== 1) return undefined;
  const parentWeight = weights.get(c.parents[0] as ObjectId);
  if (parentWeight === undefined) return undefined;
  const w = parentWeight + 1;
  weights.set(c.id, w);
  return approxHalfway(w, all) ? { nextCommit: c.id, candidateCount: all, reaches: w } : null;
};

const fillWeights = (
  candidates: ReadonlyArray<BisectCandidate>,
  weights: Map<ObjectId, number>,
  all: number,
): Bisection | undefined => {
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of candidates) {
      const outcome = tryFillOne(c, weights, all);
      if (outcome === undefined) continue;
      if (outcome === null) {
        changed = true;
        continue;
      }
      return outcome;
    }
  }
  return undefined;
};

/**
 * Verbatim port of git's `do_find_bisection` from bisect.c.
 *
 * Three-step weight-fill algorithm over an in-memory candidate DAG:
 *  1. Commits with no in-set parents get weight 1 (seeds/oldest).
 *  2. Commits with ≥2 in-set parents get `count_distance`; each is
 *     checked against `approx_halfway` immediately (early-return).
 *  3. Single-strand commits propagate weight from their parent until all
 *     weights are known; each is checked against `approx_halfway` on the spot.
 *
 * Falls back to `best_bisection` if no early-return fires.
 *
 * @param candidates In-memory candidate DAG in git's walk order.
 * @returns          The best halving commit + its weight, or `undefined` when
 *                   the candidate list is empty.
 */
export const findBisection = (
  candidates: ReadonlyArray<BisectCandidate>,
): Bisection | undefined => {
  if (candidates.length === 0) return undefined;

  const all = candidates.length;
  const byId = new Map<ObjectId, BisectCandidate>(candidates.map((c) => [c.id, c]));
  const weights = new Map<ObjectId, number>();

  seedWeights(candidates, weights);

  const mergeResult = mergeWeights(candidates, byId, weights, all);
  if (mergeResult !== undefined) return mergeResult;

  const fillResult = fillWeights(candidates, weights, all);
  if (fillResult !== undefined) return fillResult;

  const best = bestBisection(candidates, weights, all);
  return { nextCommit: best.id, candidateCount: all, reaches: best.weight };
};
