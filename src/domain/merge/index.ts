// Types

// Conflict marker serialization
export { writeConflictMarkers } from './conflict-markers.js';
// Errors
export type { MergeError } from './error.js';
export { invalidMergeInput, invalidMergeTree } from './error.js';
// Conflict labels
export {
  abbreviateOid,
  DEFAULT_MERGE_LABELS,
  type MergeLabels,
  mergeLabels,
  replayLabels,
  revertLabels,
  STASH_LABELS,
} from './merge-labels.js';
export type {
  ConflictMarkerOptions,
  ConflictType,
  ContentMergeContext,
  ContentMergeResult,
  MergeConflict,
  MergeFavor,
  MergeOutcome,
  TreeMergeResult,
} from './merge-types.js';
export { MAX_CONFLICT_OUTPUT_BYTES } from './merge-types.js';

// Three-way content merge
export { type MergeContentOptions, mergeContent } from './three-way-content.js';

// Three-way tree merge
export type { ContentMerger } from './three-way-tree.js';
export { mergeTrees } from './three-way-tree.js';
