import { operationAborted, orderInvariantViolation } from '../../../domain/error.js';
import type { FilePath } from '../../../domain/objects/index.js';
import type { OuterJoinRow } from '../../../domain/snapshot/index.js';
import type { Snapshot, SnapshotEntry } from './snapshot.js';

type SnapshotMap = { readonly [k: string]: Snapshot<SnapshotEntry> };

interface CursorState<E extends SnapshotEntry> {
  readonly slot: string;
  readonly iter: AsyncIterator<E>;
  current: IteratorResult<E>;
}

const advanceCursor = async <E extends SnapshotEntry>(
  cursor: CursorState<E>,
  previousPath: FilePath | null,
): Promise<void> => {
  cursor.current = await cursor.iter.next();
  if (!cursor.current.done && previousPath !== null) {
    const entry = cursor.current.value as { readonly path: FilePath };
    if (entry.path < previousPath) {
      throw orderInvariantViolation(previousPath, entry.path);
    }
  }
};

const buildCursors = async <S extends SnapshotMap>(
  sources: S,
  keys: ReadonlyArray<keyof S & string>,
): Promise<ReadonlyArray<CursorState<SnapshotEntry>>> => {
  const cursors: CursorState<SnapshotEntry>[] = [];
  for (const key of keys) {
    const source = sources[key];
    if (source === undefined) continue;
    const iter = source.entries()[Symbol.asyncIterator]();
    const cursor: CursorState<SnapshotEntry> = {
      slot: key,
      iter,
      current: { value: undefined as never, done: false },
    };
    await advanceCursor(cursor, null);
    cursors.push(cursor);
  }
  return cursors;
};

const minPath = (cursors: ReadonlyArray<CursorState<SnapshotEntry>>): FilePath | null => {
  let min: FilePath | null = null;
  for (const cursor of cursors) {
    if (cursor.current.done) continue;
    const path = (cursor.current.value as { readonly path: FilePath }).path;
    if (min === null || path < min) min = path;
  }
  return min;
};

export type JoinMode = 'outer' | 'inner';

/**
 * K-way path-keyed merge. On each step:
 *
 *  1. Find the minimum path across all cursors that still have rows.
 *  2. Build the row: copy each cursor's current entry into the slot
 *     whose path matches the minimum; leave others undefined.
 *  3. Yield (for `'outer'`) or yield only if every slot is populated
 *     (`'inner'`).
 *  4. Advance every cursor whose current path equals the minimum.
 *
 * Throws `OrderInvariantViolation` if any source yields a row whose path
 * is less than the previous row's path from the same source.
 */
interface MergeStep<S> {
  readonly populated: number;
  readonly row: OuterJoinRow<S>;
}

const collectMatchingSlots = async <S>(
  cursors: ReadonlyArray<CursorState<SnapshotEntry>>,
  next: FilePath,
): Promise<MergeStep<S>> => {
  const slot: Record<string, SnapshotEntry> = {};
  let populated = 0;
  for (const cursor of cursors) {
    if (cursor.current.done) continue;
    const entry = cursor.current.value as SnapshotEntry & { readonly path: FilePath };
    if (entry.path !== next) continue;
    slot[cursor.slot] = entry;
    populated += 1;
    await advanceCursor(cursor, entry.path);
  }
  return { populated, row: { path: next, ...slot } as OuterJoinRow<S> };
};

export async function* pathMerge<S extends SnapshotMap>(
  sources: S,
  keys: ReadonlyArray<keyof S & string>,
  signal: AbortSignal | undefined,
  mode: JoinMode,
): AsyncIterable<OuterJoinRow<S>> {
  const cursors = await buildCursors(sources, keys);
  while (true) {
    if (signal?.aborted === true) throw operationAborted();
    const next = minPath(cursors);
    if (next === null) return;
    const step = await collectMatchingSlots<S>(cursors, next);
    if (mode === 'inner' && step.populated !== keys.length) continue;
    yield step.row;
  }
}

/**
 * Asserts that a stream of `{ path }`-keyed rows is in non-decreasing
 * path order. Used by every downstream operator (per ADR design §11.1)
 * to confirm upstream invariants before performing work that assumes
 * ordering (e.g. groupByDir).
 */
export async function* assertOrdered<R extends { readonly path: FilePath }>(
  source: AsyncIterable<R>,
): AsyncIterable<R> {
  let previous: FilePath | null = null;
  for await (const row of source) {
    if (previous !== null && row.path < previous) {
      throw orderInvariantViolation(previous, row.path);
    }
    previous = row.path;
    yield row;
  }
}
