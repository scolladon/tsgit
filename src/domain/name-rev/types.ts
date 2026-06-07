/**
 * Pure value types for `name-rev`'s reverse-reachability naming. No I/O, no
 * rendering. A commit's name is the chosen ref plus an ordered path down to it
 * via git's `~` (first-parent) / `^` (n-th parent) notation.
 */
import type { RefName } from '../objects/object-id.js';

/** One segment of a name-rev path: `~count` (first-parent run) or `^number` (n-th parent). */
export type NameRevStep =
  | { readonly kind: 'ancestor'; readonly count: number }
  | { readonly kind: 'parent'; readonly number: number };

/**
 * Per-commit walk state — the structured form of git's `rev_name`. `steps` holds
 * the completed segments; `generation` is the pending first-parent run rendered
 * as a trailing `~generation`. `distance` is the selection metric (`+1` per
 * first-parent, `+MERGE_TRAVERSAL_WEIGHT` per `^n`); `taggerDate` is the
 * annotated tagger time, else the tip commit's date.
 */
export interface RevName {
  readonly ref: RefName;
  readonly tagDeref: boolean;
  readonly fromTag: boolean;
  readonly taggerDate: number;
  readonly generation: number;
  readonly distance: number;
  readonly steps: ReadonlyArray<NameRevStep>;
}
