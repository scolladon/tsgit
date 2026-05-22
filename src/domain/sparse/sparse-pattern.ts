import type { FilePath } from '../objects/object-id.js';

/** A single non-cone pattern, parsed and compiled. */
export interface SparseRule {
  /** Original line, for `list` output. */
  readonly source: string;
  /** True when the line started with `!` (negation). */
  readonly negated: boolean;
  /** Compiled regex — see `compileSparseRule`. */
  readonly regex: RegExp;
}

/**
 * A parsed sparse-checkout pattern set — a `cone` | `no-cone` discriminated
 * union.
 */
export type SparseSpec =
  | {
      readonly mode: 'cone';
      /** Fully-included directories — every descendant file is in the set. */
      readonly recursive: ReadonlySet<string>;
      /** Navigable-only directories — only their direct files are in the set. */
      readonly parents: ReadonlySet<string>;
    }
  | {
      readonly mode: 'no-cone';
      readonly rules: ReadonlyArray<SparseRule>;
    };

/** `true` ⇒ the path is in the sparse set (materialise it). */
export type SparseMatcher = (path: FilePath) => boolean;
