import type { UnmergedEntryGroup } from './index-diff.js';

/**
 * The seven git conflict states, each a function of which merge stages
 * (1 = base, 2 = ours, 3 = theirs) an unmerged path carries. They map to git's
 * porcelain unmerged `XY` codes: `both-modified` → `UU`, `both-added` → `AA`,
 * `both-deleted` → `DD`, `added-by-us` → `AU`, `added-by-them` → `UA`,
 * `deleted-by-us` → `DU`, `deleted-by-them` → `UD`.
 */
export type ConflictKind =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them';

/**
 * Classify an unmerged path by the presence of its base/ours/theirs stages. The
 * seven non-empty subsets of `{1,2,3}` map one-to-one onto {@link ConflictKind};
 * the fall-through final arm is the lone stage-3 case, total over a non-empty
 * group (every group built from a real index carries at least one stage).
 */
export const classifyUnmerged = (group: UnmergedEntryGroup): ConflictKind => {
  const base = group.stage1 !== undefined;
  const ours = group.stage2 !== undefined;
  const theirs = group.stage3 !== undefined;
  if (base && ours && theirs) return 'both-modified';
  if (ours && theirs) return 'both-added';
  if (base && ours) return 'deleted-by-them';
  if (base && theirs) return 'deleted-by-us';
  if (base) return 'both-deleted';
  if (ours) return 'added-by-us';
  return 'added-by-them';
};
