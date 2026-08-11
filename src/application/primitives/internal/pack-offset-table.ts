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
  readonly sortedOffsets: ReadonlyArray<number>;
  readonly packFileSize: number;
  readonly trailerStart: number;
}

function sortAscending(raw: ReadonlyArray<number>): number[] {
  return [...raw].sort((a, b) => a - b);
}

/**
 * `buildOffsetTable`'s fallback rule: gather from a usable `.rev` in O(n), or
 * sort `raw` — the pre-existing O(n log n) path — for every other artefact
 * state. The body is trusted exactly as canonical git trusts it: no digest
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
): ReadonlyArray<number> {
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

function bisectLeft(arr: ReadonlyArray<number>, value: number): number {
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
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — bisectLeft returns rank in [0, len], so rank > len is unreachable; at rank===len sortedOffsets[len] is undefined !== any numeric offset, so whether the first clause is forced always-false or its >= is mutated, the second clause fires the identical throw
  if (rank >= sortedOffsets.length || sortedOffsets[rank] !== offset) {
    throw invalidPackIndex('offset not in pack index: corrupt index');
  }
  if (rank === sortedOffsets.length - 1) {
    return trailerStart;
  }
  return sortedOffsets[rank + 1] as number;
}
