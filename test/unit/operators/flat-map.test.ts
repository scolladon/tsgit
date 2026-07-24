import { describe, expect, it } from 'vitest';
import { flatMap } from '../../../src/operators/flat-map.js';
import { toArray } from '../../../src/operators/to-array.js';
import { abortableRange, fromArray, throwingAt, trackedRange } from './fixtures.js';

type FlatMapRowReturn =
  | Iterable<unknown>
  | AsyncIterable<unknown>
  | Promise<Iterable<unknown> | AsyncIterable<unknown>>;

interface FlatMapRow {
  readonly input: readonly number[];
  readonly mapper: (n: number) => FlatMapRowReturn;
  readonly expected: readonly unknown[];
  readonly label: string;
}

describe('flatMap', () => {
  describe('Given a source array and a mapper', () => {
    describe('When iterated', () => {
      it.each<FlatMapRow>([
        {
          input: [1, 2, 3],
          mapper: (n: number) => [n, n + 10],
          expected: [1, 11, 2, 12, 3, 13],
          label: 'flattens an Iterable<U> mapper result in order',
        },
        {
          input: [1, 2],
          mapper: (n: number) => fromArray([n, n + 100]),
          expected: [1, 101, 2, 102],
          label: 'flattens an AsyncIterable<U> mapper result in order',
        },
        {
          input: [1, 2],
          mapper: async (n: number) => [n, n * 2],
          expected: [1, 2, 2, 4],
          label: 'resolves a Promise<Iterable<U>> before inner iteration begins',
        },
        {
          input: [10, 20],
          mapper: async (n: number) => fromArray([n, n + 1]),
          expected: [10, 11, 20, 21],
          label: 'resolves a Promise<AsyncIterable<U>> the same way',
        },
        {
          input: [1, 2, 3, 4],
          mapper: (n: number) => (n % 2 === 0 ? [n] : []),
          expected: [2, 4],
          label: 'an empty inner iterable contributes 0 outputs',
        },
        {
          input: [1, 2],
          mapper: (n: number) => [`${n}a`, `${n}b`, `${n}c`],
          expected: ['1a', '1b', '1c', '2a', '2b', '2c'],
          label: 'all A inner items appear before any B inner items',
        },
      ])('Then $label', async ({ input, mapper, expected }) => {
        // Arrange
        const sut = flatMap(mapper);

        // Act
        const result = await toArray(sut(fromArray(input)));

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a mapper returning Promise<[x]> whose resolution ticks a counter', () => {
    describe('When one outer item yields', () => {
      it('Then counter is 1', async () => {
        // Arrange
        let ticks = 0;
        const sut = flatMap(async (n: number) => {
          ticks += 1;
          return [n];
        });

        // Act
        await toArray(sut(fromArray([42])));

        // Assert
        expect(ticks).toBe(1);
      });
    });
  });

  describe('Given a mapper whose inner iterable throws mid-yield', () => {
    describe('When the outer reaches that inner', () => {
      it('Then outer throws AND source returnCalled() is true', async () => {
        // Arrange
        const source = trackedRange(10);
        const sut = flatMap((n: number) => {
          if (n === 2) {
            return throwingAt(0, 5);
          }
          return [n];
        });

        // Act / Assert
        await expect(toArray(sut(source.source))).rejects.toThrow(/threw at item 0/);
        expect(source.returnCalled()).toBe(true);
      });
    });
  });

  describe('Given an outer throwingAt(2, 10)', () => {
    describe('When outer throws', () => {
      it('Then flatMap generator throws', async () => {
        // Arrange
        const sut = flatMap((n: number) => [n]);

        // Act / Assert
        await expect(toArray(sut(throwingAt(2, 10)))).rejects.toThrow(/threw at item 2/);
      });
    });
  });

  describe('Given one-item outer and flatMap(() => innerTrackedRange(100))', () => {
    describe('When manual for-await breaks after first inner yield', () => {
      it('Then inner returnCalled() is true', async () => {
        // Arrange
        const inner = trackedRange(100);
        const sut = flatMap(() => inner.source);

        // Act — manual consumer, break after 1
        const seen: number[] = [];
        for await (const v of sut(fromArray([0]))) {
          seen.push(v);
          if (seen.length >= 1) break;
        }

        // Assert
        expect(seen).toEqual([0]);
        expect(inner.returnCalled()).toBe(true);
      });
    });
  });

  describe('Given multi-item outer trackedRange and flatMap to a fresh inner per outer', () => {
    describe('When consumer breaks mid-first-inner', () => {
      it('Then both outer and inner returnCalled() are true', async () => {
        // Arrange — outer must be aborted too, not only inner.
        const outer = trackedRange(10);
        const firstInner = trackedRange(100);
        let innerCallCount = 0;
        const sut = flatMap(() => {
          innerCallCount += 1;
          return firstInner.source;
        });

        // Act — break mid first inner, second outer item never pulled
        const seen: number[] = [];
        for await (const v of sut(outer.source)) {
          seen.push(v);
          if (seen.length >= 1) break;
        }

        // Assert — inner cleaned up, outer cleaned up, mapper only called once
        expect(seen).toEqual([0]);
        expect(firstInner.returnCalled()).toBe(true);
        expect(outer.returnCalled()).toBe(true);
        expect(innerCallCount).toBe(1);
      });
    });
  });

  describe('Given a trackedRange(100) outer and a consumer that throws on first yield', () => {
    describe('When the throw exits', () => {
      it('Then outer returnCalled() is true', async () => {
        // Arrange
        const source = trackedRange(100);
        const sut = flatMap((n: number) => [n]);

        // Act
        try {
          for await (const _ of sut(source.source)) {
            throw new Error('consumer-throw');
          }
        } catch {
          // swallow
        }

        // Assert
        expect(source.returnCalled()).toBe(true);
      });
    });
  });

  describe('Given an abortableRange(3, 100) outer and mapper returning [value]', () => {
    describe('When iterated to completion', () => {
      it('Then exactly 3 items yielded', async () => {
        // Arrange
        const source = abortableRange(3, 100);
        const sut = flatMap((n: number) => [n]);

        // Act
        const result = await toArray(sut(source));

        // Assert
        expect(result).toEqual([0, 1, 2]);
      });
    });
  });
});
