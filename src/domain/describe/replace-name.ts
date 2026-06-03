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
  if (incoming.priority < existing.priority) return false;
  if (incoming.priority === ANNOTATED) return incoming.taggerDate > existing.taggerDate;
  return false;
};
