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
  /** Every live (tombstone-free) record in the merge view, name-sorted —
   *  `names()` plus each name's already-resolved winning record, computed
   *  by the SAME k-way merge rather than a `names()` walk followed by one
   *  `lookup()` re-search per name. */
  entries(): Iterable<ReftableRefRecord>;
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

/** Every LIVE reflog record for `name` across the whole stack, newest first.
 *  A log record's key is `(name, update_index)`; the same key can recur in
 *  more than one table — a newer table's tombstone shadowing an older
 *  table's live entry at the entry's own `update_index` (never a fresh one,
 *  matching how the write side places a deletion). Tables never overlap in
 *  `update_index` RANGE for a fresh write, but a tombstone deliberately
 *  reuses an older index, so the shadow set must be tracked explicitly
 *  rather than assumed away — walking tables newest-to-oldest and keeping
 *  only the first (newest) record seen for each `update_index` reproduces
 *  the same newest-wins rule `lookupInStack` already applies by name. */
function* logsInStack(
  tablesNewestFirst: readonly LoadedReftable[],
  name: RefName,
): Generator<ReftableLogRecord> {
  const seenIndices = new Set<bigint>();
  for (const table of tablesNewestFirst) {
    for (const record of iterateReftableLogs(table, name)) {
      if (seenIndices.has(record.updateIndex)) continue;
      seenIndices.add(record.updateIndex);
      if (record.entry.kind !== 'deletion') yield record;
    }
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
    // Stryker disable next-line EqualityOperator: equivalent — RefName is a
    // branded primitive string; when head.name === min, `<` vs `<=` only
    // changes whether `min` is reassigned to a value equal to itself, which
    // is unobservable.
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
  // Stryker disable next-line EqualityOperator: equivalent — `index <=
  // heads.length` only adds one more iteration at index === heads.length;
  // `heads[heads.length]` is `undefined` (JS array read past the end), so
  // the loop body's own `head === undefined` guard immediately `continue`s
  // without ever touching `iterators[index]`.
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

/** The merged, tombstone-free record set: a lazy k-way walk over each
 *  table's own sorted iterator (oldest -> newest), rather than a
 *  materialised map, so a caller stops paying for the walk as soon as it
 *  stops pulling. Yields each name's WINNING record — the same one
 *  `lookup(name)` would separately re-derive by re-searching every table —
 *  so a caller that wants both the name and the resolved value never pays
 *  for that second search. */
function* mergeEntries(tables: readonly LoadedReftable[]): Generator<ReftableRefRecord> {
  const iterators = tables.map((table) => iterateReftableRefs(table)[Symbol.iterator]());
  const heads: (ReftableRefRecord | undefined)[] = iterators.map(nextOrUndefined);

  for (let next = minName(heads); next !== undefined; next = minName(heads)) {
    const winner = resolveAndAdvance(heads, iterators, next);
    if (winner.value.kind !== 'deletion') {
      yield winner;
    }
  }
}

/** `mergeEntries`, names only — `names()`'s own implementation, so the two
 *  can never drift apart on which records the merge actually yields. */
function* mergeNames(tables: readonly LoadedReftable[]): Generator<RefName> {
  for (const entry of mergeEntries(tables)) {
    yield entry.name;
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
    entries: () => mergeEntries(tables),
    logs: (name) => logsInStack(tablesNewestFirst, name),
  };
}
