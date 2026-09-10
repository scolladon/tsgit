import type { ObjectId } from '../../../domain/objects/index.js';

const EMPTY: ReadonlySet<ObjectId> = new Set();

/** The set a walk should test membership against: the caller's own set by
 *  reference, or one built from an array. Never copies a set. */
export const asIdSet = (
  until: ReadonlyArray<ObjectId> | ReadonlySet<ObjectId> | undefined,
): ReadonlySet<ObjectId> =>
  until === undefined
    ? EMPTY
    : typeof (until as ReadonlySet<ObjectId>).has === 'function'
      ? (until as ReadonlySet<ObjectId>)
      : new Set(until as ReadonlyArray<ObjectId>);
