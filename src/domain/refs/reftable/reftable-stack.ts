/**
 * The reftable stack merge view over an ordered list of loaded tables
 * (oldest -> newest, `tables.list`'s own order). Decoding a name is a merge
 * join, not a concatenation: the newest table holding a record for a name
 * wins, including a tombstone — which this view then hides, since a deleted
 * ref reads as absent to a caller. The raw per-table records (tombstones
 * included) stay reachable through `tables` for the writer and compaction
 * policy (a later part), which need to see what this view hides.
 */
import type { RefName } from '../../objects/index.js';
import {
  iterateReftableRefs,
  lookupReftableRef,
  type ReftableRefRecord,
} from './reftable-block.js';
import {
  iterateReftableLogs,
  type LoadedReftable,
  type ReftableLogRecord,
} from './reftable-log.js';

export interface ReftableStack {
  readonly tables: readonly LoadedReftable[];
  readonly maxUpdateIndex: bigint;
  lookup(name: RefName): ReftableRefRecord | undefined;
  names(): Iterable<RefName>;
  logs(name: RefName): Iterable<ReftableLogRecord>;
}

function newestFirst(tables: readonly LoadedReftable[]): readonly LoadedReftable[] {
  return [...tables].reverse();
}

/** Looks a name up newest table first: the first table holding a record
 *  wins, and a tombstone there means the name reads as absent, not that it
 *  reports as deleted — an older table's record for the same name is always
 *  shadowed, live or not. */
function lookupInStack(
  tablesNewestFirst: readonly LoadedReftable[],
  name: RefName,
): ReftableRefRecord | undefined {
  for (const table of tablesNewestFirst) {
    const found = lookupReftableRef(table, name);
    if (found !== undefined) {
      return found.value.kind === 'deletion' ? undefined : found;
    }
  }
  return undefined;
}

/** Every reflog record for `name` across the whole stack, newest first.
 *  Tables never overlap in `update_index` range, and each table's own
 *  iteration is already newest-first, so walking tables newest-to-oldest and
 *  concatenating preserves the global order without a merge or a sort. */
function* logsInStack(
  tablesNewestFirst: readonly LoadedReftable[],
  name: RefName,
): Generator<ReftableLogRecord> {
  for (const table of tablesNewestFirst) {
    yield* iterateReftableLogs(table, name);
  }
}

function nextOrUndefined(iterator: Iterator<ReftableRefRecord>): ReftableRefRecord | undefined {
  const step = iterator.next();
  return step.done ? undefined : step.value;
}

/** The lexicographically smallest name among the current per-table cursors,
 *  or `undefined` once every table is exhausted. */
function minName(heads: readonly (ReftableRefRecord | undefined)[]): RefName | undefined {
  let min: RefName | undefined;
  for (const head of heads) {
    if (head !== undefined && (min === undefined || head.name < min)) {
      min = head.name;
    }
  }
  return min;
}

/** Advances every table whose current cursor matches `name`, returning the
 *  winning record — the one from the newest (highest-index) matching table,
 *  `tables` being oldest-to-newest, so a later loop index always overwrites
 *  an earlier one. */
function resolveAndAdvance(
  heads: (ReftableRefRecord | undefined)[],
  iterators: readonly Iterator<ReftableRefRecord>[],
  name: RefName,
): ReftableRefRecord {
  let winner: ReftableRefRecord | undefined;
  for (let index = 0; index < heads.length; index += 1) {
    const head = heads[index];
    if (head === undefined || head.name !== name) {
      continue;
    }
    winner = head;
    heads[index] = nextOrUndefined(iterators[index]!);
  }
  return winner!;
}

/** The merged, tombstone-free name set: a lazy k-way walk over each table's
 *  own sorted iterator (oldest -> newest), rather than a materialised map,
 *  so a caller stops paying for the walk as soon as it stops pulling. */
function* mergeNames(tables: readonly LoadedReftable[]): Generator<RefName> {
  const iterators = tables.map((table) => iterateReftableRefs(table)[Symbol.iterator]());
  const heads: (ReftableRefRecord | undefined)[] = iterators.map(nextOrUndefined);

  for (let next = minName(heads); next !== undefined; next = minName(heads)) {
    const winner = resolveAndAdvance(heads, iterators, next);
    if (winner.value.kind !== 'deletion') {
      yield next;
    }
  }
}

function latestMaxUpdateIndex(tables: readonly LoadedReftable[]): bigint {
  if (tables.length === 0) {
    return 0n;
  }
  return tables[tables.length - 1]!.header.maxUpdateIndex;
}

/** Builds the merge view over `tables` (oldest -> newest). Pure and
 *  synchronous: every table is already loaded, so no I/O happens here. */
export function createReftableStack(tables: readonly LoadedReftable[]): ReftableStack {
  const tablesNewestFirst = newestFirst(tables);

  return {
    tables,
    maxUpdateIndex: latestMaxUpdateIndex(tables),
    lookup: (name) => lookupInStack(tablesNewestFirst, name),
    names: () => mergeNames(tables),
    logs: (name) => logsInStack(tablesNewestFirst, name),
  };
}
