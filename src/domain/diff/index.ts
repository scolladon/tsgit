// Conflict classification
export type { ConflictKind } from './classify-unmerged.js';
export { classifyUnmerged } from './classify-unmerged.js';

// Types
export type {
  AddChange,
  DeleteChange,
  DiffChange,
  DiffChangeType,
  ModifyChange,
  RenameChange,
  TreeDiff,
  TypeChangeChange,
} from './diff-change.js';

// Errors
export type { DiffError } from './error.js';
export { invalidDiffInput, invalidTreeForDiff } from './error.js';

// FlatTree
export type { FlatTree, FlatTreeEntry } from './flat-tree.js';
export { MAX_FLAT_TREE_ENTRIES } from './flat-tree.js';

// Index diff + unmerged bridges
export type { GroupedIndex, UnmergedEntryGroup } from './index-diff.js';
export {
  conflictsToIndexEntries,
  diffIndexAgainstTree,
  groupUnmergedEntries,
} from './index-diff.js';

// Line diff
export type { LineDiff, LineHunk } from './line-diff.js';
export {
  BINARY_DETECTION_BYTES,
  diffLines,
  isBinary,
  MAX_DIFF_EDIT_DISTANCE,
  MAX_DIFF_ITERATION_FACTOR,
  MAX_DIFF_LINES,
  MAX_LINE_BYTES,
  MAX_LINES,
  splitLines,
} from './line-diff.js';

// Mode-kind helpers (shared with merge)
export type { ModeKind } from './mode-kind.js';
export { isSameKind, kindOf } from './mode-kind.js';
// Patch serializer
export type { PatchFile, PatchOptions, PatchPathPrefix } from './patch-serializer.js';
export { renderPatch } from './patch-serializer.js';
// Path comparison
export { comparePaths, sortByPath } from './path-compare.js';
// Rename detection
export type { RenameDetectOptions } from './rename-detect.js';
export { detectRenames } from './rename-detect.js';

// Per-file stat counts (withStat)
export type { StatDiffChange, StatFields, StatTreeDiff } from './stat-fields.js';
export { computeStatFields } from './stat-fields.js';

// Tree diff
export { diffTrees } from './tree-diff.js';
