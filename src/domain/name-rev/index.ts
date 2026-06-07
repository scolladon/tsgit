/**
 * Internal barrel for the pure `name-rev` helpers. Deliberately NOT re-exported
 * from `domain/objects` — these stay out of the public `api.json`.
 */
export { isBetterName } from './is-better-name.js';
export {
  buildRefFilter,
  matchRefGlob,
  type RefFilter,
  type RefFilterOptions,
} from './ref-pattern.js';
export {
  firstParentName,
  foldSteps,
  MERGE_TRAVERSAL_WEIGHT,
  mergeParentName,
} from './step.js';
export type { NameRevStep, RevName } from './types.js';
