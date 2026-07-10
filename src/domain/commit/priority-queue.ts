import type { ObjectId } from '../objects/index.js';

/** A queued suspect, ordered by its commit `date` with `oid` as the tie-break. */
export interface QueueEntry<T> {
  readonly oid: ObjectId;
  readonly date: number;
  readonly value: T;
}

interface Ordered {
  readonly date: number;
  readonly oid: ObjectId;
}

/**
 * Blame's pop order: newest commit date first, oid-ascending on equal dates.
 * Mirrors git's date-priority scoreboard — a suspect pops only after every
 * newer commit, so by the time it is processed every descendant that could pass
 * blame to it already has.
 */
export const precedes = (a: Ordered, b: Ordered): boolean =>
  a.date > b.date || (a.date === b.date && a.oid < b.oid);
