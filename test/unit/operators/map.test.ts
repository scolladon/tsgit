import { expectTypeOf } from 'expect-type';
import { describe, expect, it } from 'vitest';
import { map } from '../../../src/operators/map.js';
import { toArray } from '../../../src/operators/to-array.js';
import type { Awaitable } from '../../../src/operators/types.js';
import { abortableRange, awaitable, fromArray, pullCounter, trackedRange } from './fixtures.js';

interface MapRow {
  readonly input: readonly number[];
  readonly mapper: (n: number) => Awaitable<unknown>;
  readonly expected: readonly unknown[];
  readonly label: string;
}

describe('map', () => {
  describe('Given a source array and a mapper', () => {
    describe('When sut is iterated', () => {
      it.each<MapRow>([
        {
          input: [1, 2, 3],
          mapper: (n: number) => n * 2,
          expected: [2, 4, 6],
          label: '[2,4,6] is yielded for mapper x => x * 2',
        },
        {
          input: [1, 2],
          mapper: async (n: number) => `v=${n}`,
          expected: ['v=1', 'v=2'],
          label: 'an async mapper resolves before yielding',
        },
        {
          input: [1, 2, 3],
          mapper: (n: number) => awaitable(() => n + 1),
          expected: [2, 3, 4],
          label: 'an awaitable-wrapped mapper resolves before yielding',
        },
      ])('Then $label', async ({ input, mapper, expected }) => {
        // Arrange
        const sut = map(mapper);

        // Act
        const result = await toArray(sut(fromArray(input)));

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a source of length N', () => {
    describe('When sut is iterated', () => {
      it('Then the output length equals N', async () => {
        // Arrange
        const sut = map((n: number) => n);

        // Act
        const result = await toArray(sut(fromArray([10, 20, 30, 40, 50])));

        // Assert
        expect(result).toHaveLength(5);
      });
    });
  });

  describe('Given map(x => x) (identity)', () => {
    describe('When invoked', () => {
      it('Then toArray(sut(source)) deep-equals toArray(source)', async () => {
        // Arrange
        const input = [7, 8, 9];
        const sut = map((n: number) => n);

        // Act
        const mapped = await toArray(sut(fromArray(input)));
        const passthrough = await toArray(fromArray(input));

        // Assert
        expect(mapped).toEqual(passthrough);
      });
    });
  });

  describe('Given a mapper that throws on item k', () => {
    describe('When sut is iterated past k-1', () => {
      it('Then error bubbles and trackedRange.returnCalled() is true', async () => {
        // Arrange — sentinel identity check, not regex, to resist wrap-and-rethrow mutants
        const boom = new Error('mapper-boom');
        const source = trackedRange(10);
        const sut = map((n: number) => {
          if (n === 2) throw boom;
          return n;
        });

        // Act / Assert
        await expect(toArray(sut(source.source))).rejects.toBe(boom);
        expect(source.returnCalled()).toBe(true);
      });
    });
  });

  describe('Given a mapper returning Promise<U> whose resolution ticks a counter', () => {
    describe('When sut yields 3 items', () => {
      it('Then counter reads 3 at completion', async () => {
        // Arrange
        let ticks = 0;
        const sut = map(async (n: number) => {
          ticks += 1;
          return n + 1;
        });

        // Act
        await toArray(sut(fromArray([1, 2, 3])));

        // Assert
        expect(ticks).toBe(3);
      });
    });
  });

  describe('Given a pullCounter source', () => {
    describe('When sut is constructed but not iterated', () => {
      it('Then pullCount() is 0 (laziness)', () => {
        // Arrange
        const source = pullCounter();

        // Act — just wire, do not iterate
        const _sut = map((n: number) => n + 1)(source.source);
        void _sut;

        // Assert
        expect(source.pullCount()).toBe(0);
      });
    });
    describe('When consumer pulls 5 items', () => {
      it('Then pullCount() is 5', async () => {
        // Arrange
        const source = pullCounter();
        const sut = map((n: number) => n + 1);

        // Act
        const iter = sut(source.source);
        let taken = 0;
        for await (const _ of iter) {
          taken += 1;
          if (taken >= 5) break;
        }

        // Assert
        expect(source.pullCount()).toBe(5);
      });
    });
  });

  describe('Given a trackedRange(100) and a consumer that throws after 3 pulls', () => {
    describe('When the throw exits for-await', () => {
      it('Then trackedRange.returnCalled() is true', async () => {
        // Arrange
        const source = trackedRange(100);
        const sut = map((n: number) => n);

        // Act
        let count = 0;
        try {
          for await (const _ of sut(source.source)) {
            count += 1;
            if (count >= 3) throw new Error('consumer-throw');
          }
        } catch {
          // swallow
        }

        // Assert
        expect(source.returnCalled()).toBe(true);
      });
    });
  });

  describe('Given an abortableRange(5, 100)', () => {
    describe('When sut is iterated to completion', () => {
      it('Then exactly 5 transformed items are yielded and no error is thrown', async () => {
        // Arrange
        const source = abortableRange(5, 100);
        const sut = map((n: number) => n + 10);

        // Act
        const result = await toArray(sut(source));

        // Assert
        expect(result).toEqual([10, 11, 12, 13, 14]);
      });
    });
  });

  describe('Given a type-level scenario "map((n: number) => n.toString()) returns a function AsyncIterable<number> -> AsyncIterable<string>"', () => {
    describe('When type-checked', () => {
      it('Then types align', () => {
        // Arrange
        const sut = map((n: number) => n.toString());

        // Assert (type-level)
        expectTypeOf(sut).parameter(0).toEqualTypeOf<AsyncIterable<number>>();
        expectTypeOf(sut).returns.toEqualTypeOf<AsyncIterable<string>>();
      });
    });
  });
});
