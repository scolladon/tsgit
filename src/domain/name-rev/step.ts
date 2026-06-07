/**
 * Build the next `RevName` when the walk steps from a commit to one of its
 * parents — the structured form of git `name-rev`'s `tip_name`/`generation`
 * rewriting. A first parent just bumps the pending generation; a non-first
 * parent flushes the pending generation and the `^n` jump into `steps`.
 */
import type { NameRevStep, RevName } from './types.js';

/** git's per-merge-edge distance penalty, so non-first-parent hops never win. */
export const MERGE_TRAVERSAL_WEIGHT = 65_535;

/** Step along the first parent: extend the pending first-parent run. */
export const firstParentName = (name: RevName): RevName => ({
  ...name,
  generation: name.generation + 1,
  distance: name.distance + 1,
});

/** Step to the `parentNumber`-th parent (≥ 2): flush the run + `^n`, reset the run. */
export const mergeParentName = (name: RevName, parentNumber: number): RevName => ({
  ...name,
  steps: [...foldSteps(name), { kind: 'parent', number: parentNumber }],
  generation: 0,
  distance: name.distance + MERGE_TRAVERSAL_WEIGHT,
});

/** The completed path for a name: its steps plus the pending generation as a trailing `~`. */
export const foldSteps = (name: RevName): ReadonlyArray<NameRevStep> =>
  name.generation > 0 ? [...name.steps, { kind: 'ancestor', count: name.generation }] : name.steps;
