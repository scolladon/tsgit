/**
 * Internal barrel for the pure `describe` helpers. Deliberately NOT re-exported
 * from `domain/objects` — these stay out of the public `api.json`.
 */
export { compareCandidates } from './compare-candidates.js';
export { buildNameFilter, type NameFilter, tagNameMatches } from './match.js';
export { describeName } from './ref-name.js';
export { shouldReplaceName } from './replace-name.js';
export type { Candidate, DescribeName, DescribePriority } from './types.js';
