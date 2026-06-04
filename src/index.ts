export type { AdapterSet } from './adapter-detect.js';
export { detectRuntime, isBrowser, isNode } from './adapter-detect.js';
export * from './application/commands/index.js';
export { warnDeprecated } from './application/primitives/deprecation.js';
export type { IndexEntry } from './application/primitives/snapshot/index-entry.js';
export {
  innerJoin,
  type JoinOptions,
  join,
} from './application/primitives/snapshot/join.js';
export { requireSnapshot } from './application/primitives/snapshot/require-snapshot.js';
export type {
  IndexSnapshot,
  Snapshot,
  SnapshotEntry,
  SnapshotOptions,
  TreeSnapshot,
  WorkdirSnapshot,
} from './application/primitives/snapshot/snapshot.js';
export type { SnapshotFactory } from './application/primitives/snapshot/snapshot-factory.js';
export type { StashSnapshot } from './application/primitives/snapshot/stash-snapshot.js';
export type { TreeEntry } from './application/primitives/snapshot/tree-entry.js';
export type { WorkdirEntry } from './application/primitives/snapshot/workdir-entry.js';
export type { WorkdirSnapshotOptions } from './application/primitives/snapshot/workdir-snapshot.js';
export * from './application/primitives/snapshot-operators/index.js';
export * from './ports/index.js';
export { consoleProgress, noopProgress, type ProgressReporter } from './progress.js';
