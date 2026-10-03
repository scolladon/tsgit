import type { ObjectId } from '../objects/index.js';

/** A queued commit, ordered by its commit `date`. */
export interface QueueEntry<T> {
  readonly oid: ObjectId;
  readonly date: number;
  readonly value: T;
}

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
