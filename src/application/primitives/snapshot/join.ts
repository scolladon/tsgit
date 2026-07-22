import { operationAborted } from '../../../domain/error.js';
import type { InnerJoinRow, OuterJoinRow } from '../../../domain/snapshot/index.js';
import { pathMerge } from './path-merge.js';
import type { Snapshot, SnapshotEntry } from './snapshot.js';

type SnapshotMap = { readonly [k: string]: Snapshot<SnapshotEntry> };

export interface JoinOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

// A call boundary, not an inline check: a preceding inline `aborted === true`
// throw narrows the signal so a later inline check reads as impossible, whereas
// routing every check through this helper keeps each one live.
const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw operationAborted();
};

/**
 * Single-source short-circuit: bypass the k-way merge when
 * only one source is involved. Allocates exactly one row envelope per
 * yielded entry; the merge machinery's bookkeeping is skipped entirely.
 */
async function* shortCircuit<S extends SnapshotMap, K extends keyof S & string>(
  sources: S,
  slot: K,
  signal: AbortSignal | undefined,
): AsyncIterable<OuterJoinRow<S>> {
  // Reject an already-aborted signal before touching the source so the abort
  // contract stays independent of source count: an empty single source must
  // abort promptly rather than resolve cleanly, exactly as the k-way merge does.
  throwIfAborted(signal);
  const source = sources[slot];
  // Stryker disable next-line ConditionalExpression: equivalent — slot is a key drawn from Object.keys(sources) in join, so sources[slot] is always a defined Snapshot; this guard only narrows the noUncheckedIndexedAccess union and never fires at runtime
  if (source === undefined) return;
  for await (const entry of source.entries()) {
    throwIfAborted(signal);
    const row = { path: entry.path, [slot]: entry } as unknown as OuterJoinRow<S>;
    yield row;
  }
}

/**
 * Outer-join over an arbitrary record of snapshots, keyed by path. Every
 * row carries the path plus one or more populated slot entries (a slot
 * is `undefined` when that source had no entry at the path).
 *
 * Single-source joins take the short-circuit path (one alloc per row);
 * multi-source joins delegate to the k-way merge in `path-merge.ts`.
 */
export const join = <S extends SnapshotMap>(
  sources: S,
  opts: JoinOptions = {},
): AsyncIterable<OuterJoinRow<S>> => {
  const keys = Object.keys(sources) as Array<keyof S & string>;
  const [first] = keys;
  // Single-source fast path: emit the lone source's rows verbatim, skipping
  // the k-way merge bookkeeping (and its order-invariant check).
  if (keys.length === 1 && first !== undefined) {
    return shortCircuit(sources, first, opts.signal);
  }
  return pathMerge(sources, keys, opts.signal, 'outer');
};

/**
 * Inner-join — yields rows only when every named slot has an entry at
 * the given path. Useful for "files present in both X and Y" queries
 * (e.g. unmerged paths in both index and workdir).
 */
export const innerJoin = <S extends SnapshotMap>(
  sources: S,
  opts: JoinOptions = {},
): AsyncIterable<InnerJoinRow<S>> => {
  const keys = Object.keys(sources) as Array<keyof S & string>;
  return pathMerge(sources, keys, opts.signal, 'inner') as AsyncIterable<InnerJoinRow<S>>;
};
