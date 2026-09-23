/**
 * Tiny counting semaphore bounding concurrent async work for a STREAMING
 * caller — unlike `bounded-map.ts`'s `boundedMap`, which needs every item up
 * front, a tree walker discovers work incrementally, one level at a time, so
 * new tasks arrive after earlier ones are already in flight. One limiter
 * instance is created per walk and threaded through the whole recursion (not
 * one per level), so nested levels queue behind the SAME budget rather than
 * each opening a fresh one and multiplying the effective concurrency.
 */
export interface ConcurrencyLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** `release()` walks the queue with a head cursor instead of `Array#shift()`
 *  (an O(n) copy per call, O(n²) over a long queue). The dead prefix behind
 *  the cursor is spliced away only once it exceeds this floor — small queues
 *  never pay a compaction, and a long-lived one amortises it. */
const QUEUE_COMPACTION_MIN = 1024;

export function createConcurrencyLimiter(limit: number): ConcurrencyLimiter {
  let active = 0;
  let head = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(resolve);
    });
  }

  // Drops the dead prefix behind `head` once it is both past the floor and
  // past half the live queue — bounding the splice's own cost to the same
  // order as the dead entries it reclaims. Called only after the resolver at
  // `head` has already been read into a local, so no index into `queue`
  // survives the splice.
  function compactQueueIfNeeded(): void {
    if (head > QUEUE_COMPACTION_MIN && head > queue.length / 2) {
      queue.splice(0, head);
      head = 0;
    }
  }

  // Hands the freed slot directly to the next waiter (if any) rather than
  // decrementing `active` and letting a fresh `acquire()` re-increment it —
  // keeps the released slot's ownership uninterrupted, so no third caller
  // can slip in between a release and the queued waiter it was meant for.
  function release(): void {
    const next = queue[head];
    if (next === undefined) {
      active -= 1;
      return;
    }
    head += 1;
    compactQueueIfNeeded();
    next();
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
