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

interface Arrived {
  readonly date: number;
  /** Monotonic enqueue counter — git's `prio_queue` `insertion_ctr`. */
  readonly arrival: number;
}

/**
 * git's commit `prio_queue` order: newest commit date first, and on equal
 * dates the entry enqueued first — so equal-date parents pop in parent order
 * and equal-date seeds in the order given.
 */
export const precedesByArrival = (a: Arrived, b: Arrived): boolean =>
  a.date > b.date || (a.date === b.date && a.arrival < b.arrival);
