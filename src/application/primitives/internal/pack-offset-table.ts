/**
 * A pack's successor lookup: "where does the entry at byte offset `o` end".
 * With a usable `.rev`, the answer is a binary search over `.idx`+`.rev`
 * directly — O(log N) `DataView` reads, zero allocation, canonical git's own
 * shape. No `.rev`, or one that turns out unusable, falls back to a plain
 * sorted-offsets table built straight into a `Float64Array`. Imports nothing
 * from `../pack-registry.js` — the registry owns the memo that resolves the
 * table, this module owns the table itself and the lookup built on it.
 */

import { invalidPackIndex } from '../../../domain/storage/error.js';
import {
  entryOffsetsF64,
  offsetAtPackPosition,
  type PackIndex,
  type PackRevIndex,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import type { ArtefactLoad } from './pack-artefact-source.js';
import { faultContext } from './pack-shared.js';

interface SortedOffsetTable {
  readonly kind: 'sorted';
  /**
   * `Float64Array`, not `number[]`: `TypedArray.prototype.sort` is numeric by
   * definition, so the per-element JS comparator callback a plain array would
   * need disappears, and a double represents integers up to 2^53 — well past
   * the largest offset a pack can carry into a JavaScript number.
   */
  readonly sortedOffsets: Float64Array;
  readonly packFileSize: number;
  readonly trailerStart: number;
}

interface LazyOffsetTable {
  readonly kind: 'lazy';
  readonly index: PackIndex;
  readonly rev: PackRevIndex;
  readonly objectCount: number;
  readonly packFileSize: number;
  readonly trailerStart: number;
}

export type PackOffsetTable = SortedOffsetTable | LazyOffsetTable;

/**
 * The comparator-free fallback: read every offset directly into a
 * `Float64Array` (no boxed intermediate) and sort it numerically. Canonical
 * git sorts this same table with a radix sort when it has no `.rev` to read;
 * this is the same idea within what the platform gives us for free.
 */
function buildSortedTable(index: PackIndex): Float64Array {
  const offsets = entryOffsetsF64(index);
  offsets.sort();
  return offsets;
}

/**
 * Resolves a pack's offset table. A present, loadable `.rev` always wins —
 * the discriminator is artefact presence, not object count: reading the
 * artefact is one bounded read plus a parse, and the lazy successor it
 * enables never materialises an O(n) table at all, so there is no
 * gather-vs-sort crossover left to protect. Anything else (absent,
 * unreadable, refused) falls back to the sorted table, built straight from
 * the `.idx` this pack already parsed.
 *
 * A `refused` artefact is the one state that logs (`absent`/`unreadable`
 * mirror git's own silence) — a gated-out pack stays silent about a corrupt
 * `.rev` it never opened; `fsck` remains the authority that reports the
 * fault.
 */
export async function resolveOffsetTable(
  ctx: Context,
  name: string,
  index: PackIndex,
  loadRevIndex: () => Promise<ArtefactLoad<PackRevIndex>>,
  packFileSize: number,
  trailerStart: number,
): Promise<PackOffsetTable> {
  const load = await loadRevIndex();
  if (load.kind === 'usable') {
    return {
      kind: 'lazy',
      index,
      rev: load.value,
      objectCount: index.objectCount,
      packFileSize,
      trailerStart,
    };
  }
  if (load.kind === 'refused') {
    ctx.logger?.warn?.('packRegistry: discarding unusable pack reverse index', {
      rev: `${name}.rev`,
      ...faultContext(load.data),
    });
  }
  return { kind: 'sorted', sortedOffsets: buildSortedTable(index), packFileSize, trailerStart };
}

function bisectLeft(arr: Float64Array, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as number) < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function successorFromSorted(
  sortedOffsets: Float64Array,
  trailerStart: number,
  offset: number,
): number {
  const rank = bisectLeft(sortedOffsets, offset);
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — bisectLeft returns rank in [0, len], so rank > len is unreachable; at rank===len the Float64Array yields undefined for an out-of-range index exactly as an array does, and undefined !== any numeric offset, so whether the first clause is forced always-false or its >= is mutated, the second clause fires the identical throw
  if (rank >= sortedOffsets.length || sortedOffsets[rank] !== offset) {
    throw invalidPackIndex('offset not in pack index: corrupt index');
  }
  if (rank === sortedOffsets.length - 1) {
    return trailerStart;
  }
  return sortedOffsets[rank + 1] as number;
}

/**
 * Binary search over pack positions `[0, objectCount)` for the position whose
 * `.rev`-implied offset equals `offset`, reading through `offsetAtPackPosition`
 * directly — no array materialised. Returns `'degraded'` the moment a probed
 * position's stored index position falls outside the pack's own index (a
 * corrupt or mismatched `.rev`): the signal to answer THIS query from the
 * eager fallback instead of trusting a value that cannot be resolved. Every
 * position this search does not touch stays unexamined, exactly as an O(log N)
 * search never inspects the whole input — a corruption elsewhere in the body
 * cannot perturb a convergence that never reads it.
 */
function locatePackPosition(
  index: PackIndex,
  rev: PackRevIndex,
  objectCount: number,
  offset: number,
): number | 'degraded' {
  let lo = 0;
  let hi = objectCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midOffset = offsetAtPackPosition(index, rev, mid);
    if (midOffset === undefined) return 'degraded';
    if (midOffset < offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function successorFromLazy(table: LazyOffsetTable, offset: number): number {
  const { index, rev, objectCount, trailerStart } = table;
  const rank = locatePackPosition(index, rev, objectCount, offset);
  if (rank === 'degraded') {
    return successorFromSorted(buildSortedTable(index), trailerStart, offset);
  }
  if (rank >= objectCount) {
    throw invalidPackIndex('offset not in pack index: corrupt index');
  }
  const foundOffset = offsetAtPackPosition(index, rev, rank);
  if (foundOffset === undefined) {
    return successorFromSorted(buildSortedTable(index), trailerStart, offset);
  }
  if (foundOffset !== offset) {
    throw invalidPackIndex('offset not in pack index: corrupt index');
  }
  if (rank === objectCount - 1) {
    return trailerStart;
  }
  const nextOffset = offsetAtPackPosition(index, rev, rank + 1);
  if (nextOffset === undefined) {
    return successorFromSorted(buildSortedTable(index), trailerStart, offset);
  }
  return nextOffset;
}

export function nextOffsetForEntry(table: PackOffsetTable, offset: number): number {
  if (table.kind === 'sorted') {
    return successorFromSorted(table.sortedOffsets, table.trailerStart, offset);
  }
  return successorFromLazy(table, offset);
}
