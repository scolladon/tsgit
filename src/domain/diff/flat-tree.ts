import type { FileMode, FilePath, ObjectId } from '../objects/index.js';

export interface FlatTreeEntry {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

export interface FlatTree {
  readonly entries: ReadonlyMap<FilePath, FlatTreeEntry>;
}

export const MAX_FLAT_TREE_ENTRIES = 1_000_000;

/** Default tree-recursion depth when `core.maxTreeDepth` is unset — git's own default. */
export const DEFAULT_MAX_TREE_DEPTH = 2048;
