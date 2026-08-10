/**
 * Internal barrel for the pure `name-rev` helpers. Deliberately NOT re-exported
 * from `domain/objects` — these stay out of the public `api.json`.
 */
export { commitIsBeforeCutoff, nameRevCutoff } from './cutoff.js';
export { isBetterName } from './is-better-name.js';
export { buildRefFilter, type RefFilterOptions } from './ref-pattern.js';
export { firstParentName, foldSteps, mergeParentName } from './step.js';
export type { NameRevStep, RevName } from './types.js';
