/**
 * Decide whether an incoming ref should replace the name already mapped to a
 * commit (git's `replace_name`): higher priority wins; two annotated tags on the
 * same commit are disambiguated by the newer tagger date; equal lower priorities
 * keep the first encountered (callers iterate refs in sorted name order).
 */
import type { DescribeName } from './types.js';

const ANNOTATED: DescribeName['priority'] = 2;

export const shouldReplaceName = (existing: DescribeName, incoming: DescribeName): boolean => {
  if (incoming.priority > existing.priority) return true;
  // A lower-priority incoming has priority below 2, so it is never annotated and
  // falls through to the final `false` — no explicit lower-priority guard is
  // needed. The tagger-date tie-break decides only between two annotated tags
  // (equal priority 2); reaching this branch means `existing` is annotated too.
  if (incoming.priority === ANNOTATED) return incoming.taggerDate > existing.taggerDate;
  return false;
};
