import { describe, expect, it } from 'vitest';
import {
  boundedMapFor,
  boundedReaderFor,
  defaultLimitFor,
  limiterFor,
  limitFor,
} from '../../../../../src/application/primitives/internal/concurrency.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const contextWith = (fields: Partial<Context>): Context => fields as unknown as Context;

describe('limitFor', () => {
  describe('Given a Context with no concurrency and no override', () => {
    describe('When resolving the cpuBound bucket', () => {
      it('Then it returns the safe floor', () => {
        // Arrange
        const ctx = contextWith({});
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'cpuBound');

        // Assert
        expect(result).toBe(1);
      });
    });

    describe('When resolving the ioBound bucket', () => {
      it('Then it returns the safe floor', () => {
        // Arrange
        const ctx = contextWith({});
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'ioBound');

        // Assert
        expect(result).toBe(4);
      });
    });
  });

  describe('Given a Context with derived limits and no override', () => {
    const ctx = contextWith({ concurrency: { cpuBound: 4, ioBound: 32 } });

    describe('When resolving the cpuBound bucket', () => {
      it("Then it returns the policy's cpuBound", () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'cpuBound');

        // Assert
        expect(result).toBe(4);
      });
    });

    describe('When resolving the ioBound bucket', () => {
      it("Then it returns the policy's ioBound", () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'ioBound');

        // Assert
        expect(result).toBe(32);
      });
    });
  });

  describe('Given config.parallelism set as a bare number', () => {
    const ctx = contextWith({
      concurrency: { cpuBound: 4, ioBound: 32 },
      config: { parallelism: 2 },
    });

    describe('When resolving the cpuBound bucket', () => {
      it('Then the override wins over the derived cpuBound', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'cpuBound');

        // Assert
        expect(result).toBe(2);
      });
    });

    describe('When resolving the ioBound bucket', () => {
      it('Then the same override also wins over the derived ioBound', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'ioBound');

        // Assert
        expect(result).toBe(2);
      });
    });
  });

  describe('Given config.parallelism set as { cpu } only', () => {
    const ctx = contextWith({
      concurrency: { cpuBound: 4, ioBound: 32 },
      config: { parallelism: { cpu: 2 } },
    });

    describe('When resolving the cpuBound bucket', () => {
      it('Then cpuBound is overridden', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'cpuBound');

        // Assert
        expect(result).toBe(2);
      });
    });

    describe('When resolving the ioBound bucket', () => {
      it('Then ioBound keeps the derived value — the io member is absent', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'ioBound');

        // Assert
        expect(result).toBe(32);
      });
    });
  });

  describe('Given config.parallelism set as { io } only', () => {
    const ctx = contextWith({
      concurrency: { cpuBound: 4, ioBound: 32 },
      config: { parallelism: { io: 16 } },
    });

    describe('When resolving the ioBound bucket', () => {
      it('Then ioBound is overridden', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'ioBound');

        // Assert
        expect(result).toBe(16);
      });
    });

    describe('When resolving the cpuBound bucket', () => {
      it('Then cpuBound keeps the derived value — the cpu member is absent', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'cpuBound');

        // Assert
        expect(result).toBe(4);
      });
    });
  });
});

describe('defaultLimitFor', () => {
  describe('Given no Context to consult', () => {
    describe('When resolving the cpuBound bucket', () => {
      it('Then it returns the safe floor', () => {
        // Arrange
        const sut = defaultLimitFor;

        // Act
        const result = sut('cpuBound');

        // Assert
        expect(result).toBe(1);
      });
    });

    describe('When resolving the ioBound bucket', () => {
      it('Then it returns the safe floor', () => {
        // Arrange
        const sut = defaultLimitFor;

        // Act
        const result = sut('ioBound');

        // Assert
        expect(result).toBe(4);
      });
    });
  });
});

describe('boundedMapFor', () => {
  describe('Given more items than the bucket limit', () => {
    describe('When boundedMapFor runs', () => {
      it('Then it runs at most the bucket limit concurrently', async () => {
        // Arrange
        const ctx = contextWith({ concurrency: { cpuBound: 1, ioBound: 3 } });
        const items = [1, 2, 3, 4, 5, 6, 7, 8];
        let inFlight = 0;
        let maxInFlight = 0;
        const worker = async (item: number): Promise<number> => {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await Promise.resolve();
          inFlight -= 1;
          return item;
        };
        const sut = boundedMapFor;

        // Act
        const result = await sut(ctx, 'ioBound', items, worker);

        // Assert
        expect(maxInFlight).toBe(3);
        expect(result).toEqual(items);
      });
    });
  });

  describe('Given the first item resolves slower than the rest', () => {
    describe('When boundedMapFor runs', () => {
      it('Then results come back in input order', async () => {
        // Arrange
        const ctx = contextWith({ concurrency: { cpuBound: 1, ioBound: 2 } });
        const worker = (item: number): Promise<number> =>
          item === 0
            ? new Promise((resolve) => setTimeout(() => resolve(item), 5))
            : Promise.resolve(item);
        const sut = boundedMapFor;

        // Act
        const result = await sut(ctx, 'ioBound', [0, 1, 2], worker);

        // Assert
        expect(result).toEqual([0, 1, 2]);
      });
    });
  });

  describe('Given one item rejects while its sibling is still in flight', () => {
    describe('When boundedMapFor runs', () => {
      it('Then the rejection propagates without cancelling the in-flight sibling', async () => {
        // Arrange — concurrency exactly matches item count, so both start together and
        // the sibling's own completion is observed strictly AFTER the rejection lands.
        const ctx = contextWith({ concurrency: { cpuBound: 1, ioBound: 2 } });
        let siblingSettled = false;
        const worker = async (item: number): Promise<number> => {
          if (item === 0) throw new Error('boom');
          await Promise.resolve();
          await Promise.resolve();
          siblingSettled = true;
          return item;
        };
        const sut = boundedMapFor;

        // Act
        const attempt = sut(ctx, 'ioBound', [0, 1], worker);

        // Assert — the rejection is observable well before the sibling's two
        // microtask hops resolve, yet the sibling still completes afterwards
        // instead of being torn down by the sibling's rejection.
        await expect(attempt).rejects.toThrow('boom');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(siblingSettled).toBe(true);
      });
    });
  });
});

describe('limiterFor', () => {
  describe('Given a Context whose buckets differ', () => {
    describe('When limiterFor resolves the ioBound bucket and runs a task', () => {
      it('Then the returned limiter honours that bucket and resolves the task', async () => {
        // Arrange
        const ctx = contextWith({ concurrency: { cpuBound: 1, ioBound: 2 } });
        const sut = limiterFor;
        const limiter = sut(ctx, 'ioBound');
        let inFlight = 0;
        let maxInFlight = 0;
        const task = async (): Promise<number> => {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await Promise.resolve();
          inFlight -= 1;
          return 42;
        };

        // Act
        const results = await Promise.all([
          limiter.run(task),
          limiter.run(task),
          limiter.run(task),
        ]);

        // Assert
        expect(results).toEqual([42, 42, 42]);
        expect(maxInFlight).toBe(2);
      });
    });
  });
});

describe('boundedReaderFor', () => {
  describe('Given a Context and the ioBound bucket', () => {
    describe('When boundedReaderFor starts a read', () => {
      it('Then the returned reader resolves with the read result', async () => {
        // Arrange
        const ctx = contextWith({ concurrency: { cpuBound: 1, ioBound: 2 } });
        const sut = boundedReaderFor;
        const reader = sut(ctx, 'ioBound', async (id: ObjectId) => `read:${id}`);

        // Act
        const result = await reader.start('deadbeef' as ObjectId);

        // Assert
        expect(result).toBe('read:deadbeef');
      });
    });
  });
});
