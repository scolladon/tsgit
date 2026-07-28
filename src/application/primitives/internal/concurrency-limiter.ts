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

export function createConcurrencyLimiter(limit: number): ConcurrencyLimiter {
  let active = 0;
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

  // Hands the freed slot directly to the next waiter (if any) rather than
  // decrementing `active` and letting a fresh `acquire()` re-increment it —
  // keeps the released slot's ownership uninterrupted, so no third caller
  // can slip in between a release and the queued waiter it was meant for.
  function release(): void {
    const next = queue.shift();
    if (next === undefined) {
      active -= 1;
      return;
    }
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
