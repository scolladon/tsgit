/**
 * A pack's sorted entry offsets + trailer bound, and the successor lookup
 * built on them. Holds the reverse-index accelerator: a usable `.rev` yields
 * the sorted order in O(n), every other artefact state falls back to the
 * plain sort. Imports nothing from `../pack-registry.js` — the registry owns
 * the memo that builds the table, this module owns the table itself.
 */

import { invalidPackIndex } from '../../../domain/storage/error.js';
import type { PackRevIndex } from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import type { ArtefactLoad } from './pack-artefact-source.js';
import { gatherByRevIndex } from './pack-positions.js';
import { faultContext } from './pack-shared.js';

export interface PackOffsetTable {
  /**
   * `Float64Array`, not `number[]`, and the choice is load-bearing on both
   * paths: it lets the fallback sort numerically WITHOUT a comparator
   * callback (`Array.prototype.sort` defaults to lexicographic, so a plain
   * array has no correct comparator-free sort), and it holds every offset
   * exactly — a double represents integers up to 2^53, well past the largest
   * offset a pack can carry into a JavaScript number.
   */
  readonly sortedOffsets: Float64Array;
  readonly packFileSize: number;
  readonly trailerStart: number;
}

/**
 * The comparator-free fallback: `TypedArray.prototype.sort` is numeric by
 * definition, so the per-element JS callback `[...raw].sort((a, b) => a - b)`
 * pays on every comparison disappears. Canonical git sorts this same table
 * with a radix sort when it has no `.rev` to read; this is the same idea
 * within what the platform gives us for free.
 */
function sortAscending(raw: ReadonlyArray<number>): Float64Array {
  const sorted = new Float64Array(raw);
  sorted.sort();
  return sorted;
}

/**
 * `buildOffsetTable`'s fallback rule: gather from a usable `.rev` in O(n), or
 * sort `raw` for every other artefact state. Both arms return the same
 * `Float64Array` shape, so a caller cannot tell which one ran. The body is
 * trusted exactly as canonical git trusts it: no digest
 * check runs here, and a `refused` artefact is the one state that logs
 * (`absent`/`unreadable` mirror git's own silence). A stored position at or
 * beyond `raw.length` degrades this ONE pack to the sort rather than let
 * `undefined` reach `nextOffsetForEntry`.
 */
export function resolveSortedOffsets(
  ctx: Context,
  name: string,
  raw: ReadonlyArray<number>,
  load: ArtefactLoad<PackRevIndex>,
): Float64Array {
  if (load.kind === 'refused') {
    ctx.logger?.warn?.('packRegistry: discarding unusable pack reverse index', {
      rev: `${name}.rev`,
      ...faultContext(load.data),
    });
    return sortAscending(raw);
  }
  if (load.kind !== 'usable') return sortAscending(raw);
  const gathered = gatherByRevIndex(load.value, raw);
  if (gathered !== undefined) return gathered;
  ctx.logger?.warn?.(
    'packRegistry: pack reverse index position out of range, falling back to sort',
    { rev: `${name}.rev` },
  );
  return sortAscending(raw);
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

export function nextOffsetForEntry(table: PackOffsetTable, offset: number): number {
  const { sortedOffsets, trailerStart } = table;
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
