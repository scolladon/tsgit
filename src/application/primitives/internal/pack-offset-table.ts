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
 * Object count from which reading a pack's `.rev` starts to pay for itself
 * against simply sorting the offsets.
 *
 * Reading the artefact costs one bounded read plus a parse — a cost that is
 * essentially FIXED per pack — to replace a sort that costs O(n log n) but
 * with a very low constant now that it runs comparator-free. Below the
 * crossover the fixed cost dominates and the accelerator only slows things
 * down; above it the better growth rate takes over. Measured per pack,
 * `.rev` present vs deleted:
 *
 * |   objects | `.rev` | sort  | winner       |
 * |----------:|-------:|------:|--------------|
 * |     3,000 |  0.494 | 0.416 | sort  +18.8% |
 * |    10,000 |  0.648 | 0.820 | `.rev` +20.9% |
 * |    20,000 |  0.933 | 1.472 | `.rev` +36.6% |
 * |    40,000 |  1.412 | 2.913 | `.rev` +51.5% |
 *
 * The exact crossover moves with the machine's I/O-to-CPU ratio, so this is a
 * tuned number rather than a derived one — but being slightly wrong costs
 * almost nothing, because a value near the crossover is by definition a value
 * where the two paths cost the same. It is the FAR side that matters: many
 * small packs (a repository between `git gc` runs) paid this fixed cost once
 * per pack for no benefit at all.
 */
export const REV_INDEX_MIN_OBJECTS = 5_000;

/**
 * `buildOffsetTable`'s rule: below `REV_INDEX_MIN_OBJECTS`, sort and never
 * touch the artefact — the loader is passed unforced precisely so that the
 * threshold skips the READ and not merely the gather, which is where the
 * whole saving lives. Above it, gather from a usable `.rev` in O(n) and fall
 * back to the sort for every other artefact state. Every arm returns the same
 * `Float64Array` shape, so a caller cannot tell which one ran.
 *
 * The body is trusted exactly as canonical git trusts it: no digest check
 * runs here, and a `refused` artefact is the one state that logs
 * (`absent`/`unreadable` mirror git's own silence). A stored position at or
 * beyond `raw.length` degrades this ONE pack to the sort rather than let
 * `undefined` reach `nextOffsetForEntry`.
 *
 * A gated-out pack is silent about a corrupt `.rev` it never opened, which is
 * git's own posture: git does not diagnose an artefact it had no reason to
 * read. `fsck` remains the authority that reports the fault.
 */
export async function resolveSortedOffsets(
  ctx: Context,
  name: string,
  raw: ReadonlyArray<number>,
  loadRevIndex: () => Promise<ArtefactLoad<PackRevIndex>>,
): Promise<Float64Array> {
  if (raw.length < REV_INDEX_MIN_OBJECTS) return sortAscending(raw);
  const load = await loadRevIndex();
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
