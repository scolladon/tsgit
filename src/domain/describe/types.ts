/**
 * Pure value types for `describe`'s nearest-tag selection. No I/O, no rendering.
 */
import type { ObjectId } from '../objects/object-id.js';

/** Priority of a ref as a describe name: annotated tag > lightweight tag > other ref. */
export type DescribePriority = 0 | 1 | 2;

/** One entry of the commit→name map. `taggerDate` is `0` unless `priority === 2`. */
export interface DescribeName {
  /** Short name as `describe` reports it (e.g. `v2.0`, `heads/main`). */
  readonly name: string;
  readonly priority: DescribePriority;
  /** Outermost annotated-tag tagger timestamp; `0` for non-annotated names. */
  readonly taggerDate: number;
}

/** A tag discovered during the walk, with its running depth from the target. */
export interface Candidate {
  readonly name: string;
  readonly commitOid: ObjectId;
  /** Commits between this tag and the target. Mutated in place during the walk. */
  depth: number;
  /** Order of discovery in the date-ordered walk (tie-break key). */
  readonly foundOrder: number;
}
