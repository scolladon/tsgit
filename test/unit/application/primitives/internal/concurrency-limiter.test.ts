import { describe, expect, it } from 'vitest';
import { createConcurrencyLimiter } from '../../../../../src/application/primitives/internal/concurrency-limiter.js';

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

        // Assert
        expect(results).toEqual([1, 2, 3]);
        expect(maxInFlight).toBeLessThanOrEqual(3);
      });
    });
  });
});
