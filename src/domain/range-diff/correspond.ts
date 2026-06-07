/**
 * Pair the patches of two ranges at minimum total cost — git's
 * `find_exact_matches` + `get_correspondences` (`range-diff.c`). Patches with
 * byte-identical `diff` slices are paired first (a hashmap, LIFO on duplicate
 * keys, mirroring git's bucket-head removal); the rest go through a square cost
 * matrix solved by `computeAssignment`. Cell costs: `0` for an exact pair,
 * `diffSize` of the two diff slices for a free pair, `COST_MAX` for a cell that
 * would re-pair an exact match; creation/deletion dummies cost
 * `diffsize * creationFactor / 100` (integer division).
 */

import { diffSize } from './diff-size.js';
import { COST_MAX, computeAssignment } from './linear-assignment.js';
import type { RenderedPatch } from './patch-text.js';

export interface MatchedPatch {
  readonly patch: RenderedPatch;
  /** Index of the matched patch on the other side, or `-1` if unmatched. */
  readonly matching: number;
}

export interface Correspondence {
  readonly old: ReadonlyArray<MatchedPatch>;
  readonly new: ReadonlyArray<MatchedPatch>;
}

/** Exact-match the diff slices, returning the per-side partner index (or -1). */
const exactMatches = (
  oldPatches: ReadonlyArray<RenderedPatch>,
  newPatches: ReadonlyArray<RenderedPatch>,
): { readonly exactOld: number[]; readonly exactNew: number[] } => {
  const exactOld = new Array<number>(oldPatches.length).fill(-1);
  const exactNew = new Array<number>(newPatches.length).fill(-1);
  const byDiff = new Map<string, number[]>();
  oldPatches.forEach((p, i) => {
    const bucket = byDiff.get(p.diff);
    if (bucket) bucket.push(i);
    else byDiff.set(p.diff, [i]);
  });
  newPatches.forEach((p, j) => {
    const bucket = byDiff.get(p.diff);
    const i = bucket?.pop(); // LIFO: highest old index first (git hashmap head)
    if (i !== undefined) {
      exactOld[i] = j;
      exactNew[j] = i;
    }
  });
  return { exactOld, exactNew };
};

/** Integer creation/deletion cost for a patch (git's `diffsize * factor / 100`). */
const dummyCost = (matched: number, diffsize: number, creationFactor: number): number =>
  matched < 0 ? Math.trunc((diffsize * creationFactor) / 100) : COST_MAX;

const cellCost = (
  oldPatch: RenderedPatch,
  newPatch: RenderedPatch,
  exactOldI: number,
  exactNewJ: number,
  j: number,
): number => {
  if (exactOldI === j) return 0;
  // equivalent-mutant: loosening this guard (`< 0` → `<= 0`, or forcing it true)
  // only ever turns a forbidden COST_MAX cell into a finite cost for a row/column
  // that is already exact-matched elsewhere at cost 0. The cost-0 exact pair
  // dominates the assignment, so the forbidden cell's value cannot change the
  // chosen matching.
  if (exactOldI < 0 && exactNewJ < 0) return diffSize(oldPatch.diff, newPatch.diff);
  return COST_MAX;
};

const buildCostMatrix = (
  oldPatches: ReadonlyArray<RenderedPatch>,
  newPatches: ReadonlyArray<RenderedPatch>,
  exactOld: ReadonlyArray<number>,
  exactNew: ReadonlyArray<number>,
  creationFactor: number,
): number[] => {
  const n = oldPatches.length;
  const m = newPatches.length;
  const total = n + m;
  const cost = new Array<number>(total * total).fill(0); // dummy×dummy stays 0
  for (let i = 0; i < n; i++) {
    // equivalent-mutant (`j < m` → `j <= m`): the extra `j === m` cell is the first
    // dummy column, overwritten immediately by the deletion loop below.
    for (let j = 0; j < m; j++) {
      cost[i + total * j] = cellCost(oldPatches[i]!, newPatches[j]!, exactOld[i]!, exactNew[j]!, j);
    }
    const del = dummyCost(exactOld[i]!, oldPatches[i]!.diffsize, creationFactor);
    // equivalent-mutant (`j < total` → `j <= total`): the extra `j === total` write
    // lands at flat index `i + total*total`, past the matrix; the solver never reads it.
    for (let j = m; j < total; j++) cost[i + total * j] = del;
  }
  for (let j = 0; j < m; j++) {
    const create = dummyCost(exactNew[j]!, newPatches[j]!.diffsize, creationFactor);
    for (let i = n; i < total; i++) cost[i + total * j] = create;
  }
  return cost;
};

export const correspond = (
  oldPatches: ReadonlyArray<RenderedPatch>,
  newPatches: ReadonlyArray<RenderedPatch>,
  creationFactor: number,
): Correspondence => {
  const n = oldPatches.length;
  const m = newPatches.length;
  const oldMatching = new Array<number>(n).fill(-1);
  const newMatching = new Array<number>(m).fill(-1);

  const { exactOld, exactNew } = exactMatches(oldPatches, newPatches);
  const total = n + m;
  const cost = buildCostMatrix(oldPatches, newPatches, exactOld, exactNew, creationFactor);
  const { columnToRow } = computeAssignment(total, cost);
  for (let i = 0; i < n; i++) {
    const j = columnToRow[i]!;
    if (j >= 0 && j < m) {
      oldMatching[i] = j;
      newMatching[j] = i;
    }
  }

  return {
    old: oldPatches.map((patch, i) => ({ patch, matching: oldMatching[i]! })),
    new: newPatches.map((patch, j) => ({ patch, matching: newMatching[j]! })),
  };
};
