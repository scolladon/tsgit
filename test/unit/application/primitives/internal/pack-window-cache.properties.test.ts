import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createPackWindowCache } from '../../../../../src/application/primitives/internal/pack-window-cache.js';

describe('createPackWindowCache — read against a direct slice', () => {
  describe('Given an arbitrary byte array and arbitrary in-bounds offset/length over arbitrary window/limit budgets', () => {
    describe('When read is called', () => {
      it('Then it returns the same bytes as a direct subarray of the source', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.uint8Array({ minLength: 1, maxLength: 500 }),
            fc.integer({ min: 1, max: 64 }),
            fc.integer({ min: 1, max: 256 }),
            fc.nat(),
            fc.nat(),
            async (bytes, windowBytes, limitBytes, offsetSeed, lengthSeed) => {
              // Arrange — derive an in-bounds (offset, length) pair from the
              // seeds so every generated case is a valid slice of `bytes`.
              const offset = offsetSeed % bytes.length;
              const length = 1 + (lengthSeed % (bytes.length - offset));
              const load = async (base: number, size: number): Promise<Uint8Array> =>
                bytes.subarray(base, base + size);
              const cache = createPackWindowCache({ windowBytes, limitBytes });

              // Act
              const result = await cache.read('pack', offset, length, load);

              // Assert
              expect(Array.from(result)).toEqual(
                Array.from(bytes.subarray(offset, offset + length)),
              );
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
