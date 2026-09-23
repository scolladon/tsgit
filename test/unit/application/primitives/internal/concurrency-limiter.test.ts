import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createConcurrencyLimiter } from '../../../../../src/application/primitives/internal/concurrency-limiter.js';

/** Runs `taskCount` tasks (indices 0..taskCount-1, admitted in that order)
 *  through `sut` and returns the order each task body actually started in. */
async function runIndexedTasks(
  sut: ReturnType<typeof createConcurrencyLimiter>,
  taskCount: number,
): Promise<{ started: number[]; results: number[] }> {
  const started: number[] = [];
  const results = await Promise.all(
    Array.from({ length: taskCount }, (_, index) =>
      sut.run(async () => {
        started.push(index);
        return index;
      }),
    ),
  );
  return { started, results };
}

const admissionOrder = (taskCount: number): number[] =>
  Array.from({ length: taskCount }, (_, index) => index);

describe('createConcurrencyLimiter', () => {
  describe('Given limit=2 and 5 tasks submitted at once', () => {
    describe('When every task runs through the limiter', () => {
      it('Then in-flight count never exceeds the limit but does exceed 1', async () => {
        // Arrange
        let inFlight = 0;
        let maxInFlight = 0;
        const task = async (n: number): Promise<number> => {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await Promise.resolve();
          inFlight -= 1;
          return n;
        };
        const sut = createConcurrencyLimiter(2);

        // Act
        const results = await Promise.all([1, 2, 3, 4, 5].map((n) => sut.run(() => task(n))));

        // Assert
        expect(results).toEqual([1, 2, 3, 4, 5]);
        expect(maxInFlight).toBeLessThanOrEqual(2);
        expect(maxInFlight).toBeGreaterThan(1);
      });
    });
  });

  describe('Given limit=1 and 3 tasks submitted at once', () => {
    describe('When every task runs through the limiter', () => {
      it('Then tasks never overlap and run in FIFO submission order', async () => {
        // Arrange
        const started: number[] = [];
        const task = async (n: number): Promise<number> => {
          started.push(n);
          await Promise.resolve();
          await Promise.resolve();
          return n;
        };
        const sut = createConcurrencyLimiter(1);

        // Act
        const results = await Promise.all([1, 2, 3].map((n) => sut.run(() => task(n))));

        // Assert — strictly serialized, in the order submitted
        expect(started).toEqual([1, 2, 3]);
        expect(results).toEqual([1, 2, 3]);
      });
    });
  });

  describe('Given a task that rejects while a second task is queued behind it', () => {
    describe('When the first task runs through the limiter', () => {
      it('Then the rejection propagates from run() without deadlocking the queued task', async () => {
        // Arrange
        const sut = createConcurrencyLimiter(1);
        const failing = sut.run(async () => {
          throw new Error('boom');
        });
        failing.catch(() => {});

        // Act
        const queued = sut.run(async () => 'second');

        // Assert
        await expect(failing).rejects.toThrow('boom');
        await expect(queued).resolves.toBe('second');
      });
    });
  });

  describe('Given a limit-1 limiter whose only task has already completed', () => {
    describe('When a second task is run after the first finished', () => {
      it('Then the second task starts without queueing (the freed slot returned to the pool)', async () => {
        // Arrange
        const sut = createConcurrencyLimiter(1);
        await sut.run(async () => 'first');
        let secondStarted = false;

        // Act
        const second = sut.run(async () => {
          secondStarted = true;
          return 'second';
        });
        await Promise.resolve();

        // Assert
        expect(secondStarted).toBe(true);
        await expect(second).resolves.toBe('second');
      });
    });
  });

  describe('Given limit greater than the number of tasks', () => {
    describe('When every task runs through the limiter', () => {
      it('Then concurrency caps at the task count, not the limit', async () => {
        // Arrange
        let inFlight = 0;
        let maxInFlight = 0;
        const task = async (n: number): Promise<number> => {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await Promise.resolve();
          inFlight -= 1;
          return n;
        };
        const sut = createConcurrencyLimiter(100);

        // Act
        const results = await Promise.all([1, 2, 3].map((n) => sut.run(() => task(n))));

        // Assert — exactly the task count, not merely at-or-under it (which a
        // fully serialising bug, maxInFlight === 1, would also satisfy).
        expect(results).toEqual([1, 2, 3]);
        expect(maxInFlight).toBe(3);
      });
    });
  });

  describe('Given an arbitrary limit and an arbitrary count of tasks with staggered completion', () => {
    describe('When every task is submitted at once through the limiter', () => {
      it('Then tasks start in admission order and in-flight never exceeds the limit', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 8 }),
            fc.array(fc.nat({ max: 5 }), { maxLength: 60 }),
            async (limit, ticks) => {
              const sut = createConcurrencyLimiter(limit);
              const started: number[] = [];
              let active = 0;
              let maxActive = 0;

              const results = await Promise.all(
                ticks.map((tickCount, index) =>
                  sut.run(async () => {
                    started.push(index);
                    active += 1;
                    maxActive = Math.max(maxActive, active);
                    for (let i = 0; i < tickCount; i += 1) await Promise.resolve();
                    active -= 1;
                    return index;
                  }),
                ),
              );

              return (
                maxActive <= limit &&
                results.every((value, index) => value === index) &&
                started.every((value, index) => value === index)
              );
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a limit-1 limiter with 2 × 1024 + 1 tasks queued behind the first', () => {
    describe('When every task runs to completion', () => {
      it('Then start order still equals admission order across a queue compaction', async () => {
        // Arrange
        const QUEUED_TASK_COUNT = 2 * 1024 + 1;
        const TOTAL_TASK_COUNT = QUEUED_TASK_COUNT + 1;
        const sut = createConcurrencyLimiter(1);

        // Act
        const { started, results } = await runIndexedTasks(sut, TOTAL_TASK_COUNT);

        // Assert
        expect(started).toEqual(admissionOrder(TOTAL_TASK_COUNT));
        expect(results).toEqual(admissionOrder(TOTAL_TASK_COUNT));
      });
    });
  });

  describe('Given a limit-1 limiter whose queue is far larger than twice the compaction floor', () => {
    describe('When every task runs to completion', () => {
      it('Then FIFO holds while the head cursor is past the floor but still under half the queue', async () => {
        // Arrange — 4000 queued tasks: the head cursor spends a wide stretch
        // (1025..2000) past QUEUE_COMPACTION_MIN yet under half of 4000,
        // deferring compaction, before a later stretch clears it.
        const QUEUED_TASK_COUNT = 4000;
        const TOTAL_TASK_COUNT = QUEUED_TASK_COUNT + 1;
        const sut = createConcurrencyLimiter(1);

        // Act
        const { started, results } = await runIndexedTasks(sut, TOTAL_TASK_COUNT);

        // Assert
        expect(started).toEqual(admissionOrder(TOTAL_TASK_COUNT));
        expect(results).toEqual(admissionOrder(TOTAL_TASK_COUNT));
      });
    });
  });
});
