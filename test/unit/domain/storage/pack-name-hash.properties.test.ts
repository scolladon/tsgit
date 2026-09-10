import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { concatBytes } from '../../../../src/domain/objects/encoding.js';
import { foldPackNameHash, packNameHash } from '../../../../src/domain/storage/pack-name-hash.js';
import { arbNameBytes } from './arbitraries.js';

describe('packNameHash properties', () => {
  describe('Given an arbitrary path split into two byte chunks', () => {
    describe('When folding each chunk in sequence versus hashing the concatenation', () => {
      it('Then the folded composition matches a single-pass hash', () => {
        // Arrange + Act + Assert
        const sut = foldPackNameHash;

        fc.assert(
          fc.property(arbNameBytes(), arbNameBytes(), (first, second) => {
            const result = sut(sut(0, first), second);

            expect(result).toBe(packNameHash(concatBytes([first, second])));
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary path and an arbitrary insertion index', () => {
    describe('When inserting any of the four skipped whitespace bytes', () => {
      it('Then the hash is unchanged', () => {
        // Arrange + Act + Assert
        const sut = packNameHash;

        fc.assert(
          fc.property(
            arbNameBytes(),
            fc.nat(),
            fc.constantFrom(0x09, 0x0a, 0x0d, 0x20),
            (bytes, rawIndex, spaceByte) => {
              const index = bytes.length === 0 ? 0 : rawIndex % (bytes.length + 1);
              const withSpace = concatBytes([
                bytes.subarray(0, index),
                Uint8Array.of(spaceByte),
                bytes.subarray(index),
              ]);

              const result = sut(withSpace);

              expect(result).toBe(sut(bytes));
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given arbitrary path bytes', () => {
    describe('When computing the name hash', () => {
      it('Then the result is always a uint32 and the function never throws', () => {
        // Arrange + Act + Assert
        const sut = packNameHash;

        fc.assert(
          fc.property(arbNameBytes(), (bytes) => {
            const result = sut(bytes);

            expect(Number.isInteger(result)).toBe(true);
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThan(2 ** 32);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  // A fourth property asserting that any prefix washes out once a shared
  // suffix reaches sixteen non-space bytes was drafted and dropped: `>>> 2`
  // is integer division, and its rounding can carry a one-bit residue from
  // an early byte forward indefinitely once mixed with later bytes. Fed
  // uniformly random suffixes, that residue survives past a sixteen-byte
  // shared tail roughly half the time (confirmed against a byte-for-byte
  // port of the reference C fold), so no fixed window length holds as an
  // exact equality over arbitrary bytes — only the two pinned examples in
  // the example-test file, whose specific byte values happen not to carry,
  // do.
});
