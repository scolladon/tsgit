/**
 * git `name-rev`'s `is_better_name`: decide whether an `incoming` name should
 * replace the `existing` one for a commit. Pinned against real git 2.54 (the
 * in-tree "prefer the older tag even if farther" comment does not match observed
 * behaviour — distance dominates; tagger date is only the equal-distance
 * tie-break): a tag beats a non-tag at any distance, then the nearer name wins,
 * then the older-tagged name wins. A full tie keeps the existing name.
 */
import type { RevName } from './types.js';

export const isBetterName = (existing: RevName, incoming: RevName): boolean => {
  if (existing.fromTag !== incoming.fromTag) return incoming.fromTag;
  // equivalent-mutant: this line runs only when the distances differ, so `>` and
  // `>=` are identical here — the `>=` mutant is provably equivalent (unkillable).
  if (existing.distance !== incoming.distance) return existing.distance > incoming.distance;
  return existing.taggerDate > incoming.taggerDate;
};
