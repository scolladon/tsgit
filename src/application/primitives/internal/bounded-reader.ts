import type { ObjectId } from '../../../domain/objects/index.js';

/** A bounded, per-id-deduped reader — every id is read at most once, at most `bound` concurrently. */
export interface BoundedReader<T> {
  /** Ensure a read for `id` is started; idempotent per id. Returns its (possibly still-pending) result. */
  readonly start: (id: ObjectId) => Promise<T>;
  /** Drop `id`'s memo entry once its result has been consumed — the memo only
   *  needs to dedup reads that are still in flight or enqueued; retaining every
   *  resolved body would grow O(commits-walked) over a full history drain. */
  readonly forget: (id: ObjectId) => void;
}

/**
 * Wrap `read` with a small counting semaphore (bound concurrent calls) plus
 * per-id memoization, so repeated `start` calls for the same id share one
 * underlying read and the walk can fire off many `start` calls without
 * awaiting them individually — overlapping I/O instead of serializing it.
 */
export function createBoundedReader<T>(
  bound: number,
  read: (id: ObjectId) => Promise<T>,
): BoundedReader<T> {
  const promises = new Map<ObjectId, Promise<T>>();
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < bound) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  };

  const start = (id: ObjectId): Promise<T> => {
    const existing = promises.get(id);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      await acquire();
      try {
        return await read(id);
      } finally {
        release();
      }
    })();
    promises.set(id, pending);
    // A `start` call is fire-and-forget from the caller's perspective — the
    // real await happens later, when the walk pops this id. Attach a silent
    // reaction now so Node never reports it as an unhandled rejection in the
    // meantime; the original `pending` promise (returned below) still rejects
    // normally for whoever actually awaits it.
    pending.catch(() => {});
    return pending;
  };

  return { start, forget: (id) => void promises.delete(id) };
}
