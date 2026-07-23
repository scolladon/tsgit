import { describe, expect, it, vi } from 'vitest';
import { filter } from '../../../src/operators/filter.js';
import { toArray } from '../../../src/operators/to-array.js';
import {
  abortableRange,
  awaitable,
  fromArray,
  pullCounter,
  throwingPredicate,
  trackedRange,
} from './fixtures.js';

describe('filter', () => {
  describe('Given a source array and a boolean-yielding predicate', () => {
    describe('When sut is iterated', () => {
      it.each([
        {
          input: [1, 2, 3, 4],
          predicate: (n: number) => n % 2 === 0,
          expected: [2, 4],
          label: '[2,4] is yielded in order for an even predicate',
        },
        {
          input: [1, 2, 3],
          predicate: () => false,
          expected: [],
          label: '[] is yielded when the predicate is always false',
        },
        {
          input: [-1, 1, -2, 2],
          predicate: async (n: number) => n > 0,
          expected: [1, 2],
          label: 'an async predicate keeps only items where n > 0',
        },
        {
          input: [0, 1, 2, 3],
          predicate: (n: number) => awaitable(() => n > 1),
          expected: [2, 3],
          label: 'an awaitable-wrapped predicate filters correctly',
        },
        {
          input: [1],
          predicate: () => true,
          expected: [1],
          label: '[1] is yielded when the predicate is always true',
        },
        {
          input: [1],
          predicate: () => false,
          expected: [],
          label: '[] is yielded for source [1] when the predicate is always false',
        },
        {
          input: [1, 2, 3, 4, 5],
          predicate: async (n: number) => n > 0,
          expected: [1, 2, 3, 4, 5],
          label: 'an async predicate resolving on the next microtask preserves source order',
        },
      ])('Then $label', async ({ input, predicate, expected }) => {
        // Arrange
        const sut = filter(predicate);

        // Act
        const result = await toArray(sut(fromArray(input)));

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a predicate returning true for all items', () => {
    describe('When invoked', () => {
      it('Then toArray(sut(source)) deep-equals toArray(source)', async () => {
        // Arrange
        const input = [1, 2, 3];
        const sut = filter(() => true);

        // Act
        const filtered = await toArray(sut(fromArray(input)));
        const passthrough = await toArray(fromArray(input));

        // Assert
        expect(filtered).toEqual(passthrough);
      });
    });
  });

  describe('Given a throwingPredicate that throws on item k', () => {
    describe('When sut is iterated past k-1', () => {
      it('Then error bubbles AND source returnCalled() is true', async () => {
        // Arrange
        const source = trackedRange(10);
        const boom = new Error('pred-boom');
        const sut = filter(throwingPredicate<number>((n) => n === 2, boom));

        // Act / Assert
        await expect(toArray(sut(source.source))).rejects.toBe(boom);
        expect(source.returnCalled()).toBe(true);
      });
    });
  });

  describe('Given a predicate-spy and consumer breaking at item 5 of 100', () => {
    describe('When sut is iterated', () => {
      it('Then predicate is called exactly 5 times', async () => {
        // Arrange
        const spy = vi.fn((_n: number) => true);
        const sut = filter(spy);

        // Act
        let taken = 0;
        for await (const _ of sut(trackedRange(100).source)) {
          taken += 1;
          if (taken >= 5) break;
        }

        // Assert
        expect(spy).toHaveBeenCalledTimes(5);
      });
    });
  });

  describe('Given a pullCounter source and filter(() => true)', () => {
    describe('When consumer pulls 5 items', () => {
      it('Then pullCount() is 5', async () => {
        // Arrange
        const source = pullCounter();
        const sut = filter(() => true);

        // Act
        let taken = 0;
        for await (const _ of sut(source.source)) {
          taken += 1;
          if (taken >= 5) break;
        }

        // Assert
        expect(source.pullCount()).toBe(5);
      });
    });
  });

  describe('Given a trackedRange(100) and a consumer that throws after 3 items', () => {
    describe('When the throw exits for-await', () => {
      it('Then trackedRange.returnCalled() is true', async () => {
        // Arrange
        const source = trackedRange(100);
        const sut = filter(() => true);

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

  describe('Given an abortableRange(5, 100) and filter(() => true)', () => {
    describe('When sut is iterated to completion', () => {
      it('Then exactly [0,1,2,3,4] is yielded', async () => {
        // Arrange
        const source = abortableRange(5, 100);
        const sut = filter(() => true);

        // Act
        const result = await toArray(sut(source));

        // Assert
        expect(result).toEqual([0, 1, 2, 3, 4]);
      });
    });
  });
});
