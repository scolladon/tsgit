import type { Pathspec } from '../../../domain/pathspec/index.js';
import type { SnapshotKind } from '../../../domain/snapshot/index.js';
import type { IndexEntry } from './index-entry.js';
import type { TreeEntry } from './tree-entry.js';
import type { WorkdirEntry } from './workdir-entry.js';

/**
 * Lazy, atomic-iteration view of a row source (tree / index / workdir / …).
 * Snapshots are descriptions, not data — no I/O happens until the consumer
 * starts iterating. See design §8 and ADR-149.
 *
 * Iteration-stability invariant: once a snapshot's `entries()` resolves its
 * underlying source on the first iteration, every subsequent iteration on
 * the same handle replays from that captured source. Concurrent writes
 * routed through `WriteEventEmitter.emit(scope)` invalidate the underlying
 * resolver cache for *new* snapshots but never disturb in-flight iterations.
 */
export interface Snapshot<E extends SnapshotEntry> {
  readonly kind: SnapshotKind;
  entries(opts?: SnapshotOptions): AsyncIterable<E>;
}

export type SnapshotEntry = TreeEntry | IndexEntry | WorkdirEntry;

export type TreeSnapshot = Snapshot<TreeEntry>;
export type IndexSnapshot = Snapshot<IndexEntry>;
export type WorkdirSnapshot = Snapshot<WorkdirEntry>;

export interface SnapshotOptions {
  readonly paths?: Pathspec;
  readonly recurse?: boolean;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly bypassCache?: boolean;
  readonly signal?: AbortSignal;
}
