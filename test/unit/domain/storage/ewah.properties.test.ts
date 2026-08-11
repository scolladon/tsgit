import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import {
  foldEwahStream,
  maxSetBitPosition,
  readEwahStream,
} from '../../../../src/domain/storage/ewah.js';
import { arbBitSet, EWAH_BIT_RANGE, encodeEwah } from './arbitraries.js';

function bitsOf(into: Uint32Array): ReadonlyArray<number> {
  const bits: number[] = [];
  into.forEach((lane, laneIndex) => {
    for (let b = 0; b < 32; b += 1) {
      if ((lane & (1 << b)) !== 0) bits.push(laneIndex * 32 + b);
    }
  });
  return bits;
}

describe('ewah properties', () => {
  describe('Given an arbitrary sparse or dense bit set over [0, 5000)', () => {
    describe('When encoding then reading and folding into a zeroed destination', () => {
      it('Then it reproduces the bit set exactly', () => {
        // Arrange + Act + Assert
        const sut = foldEwahStream;
        const laneCount = Math.ceil(EWAH_BIT_RANGE / 32);

        fc.assert(
          fc.property(arbBitSet(), (bits) => {
            const bytes = encodeEwah(bits, EWAH_BIT_RANGE);
            const view = new DataView(bytes.buffer);
            const stream = readEwahStream(bytes, view, 0);
            const into = new Uint32Array(laneCount);

            sut(bytes, view, stream, into, 'or');

            expect(bitsOf(into)).toEqual([...bits].sort((a, b) => a - b));
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary byte string up to 4 KiB, at various offsets', () => {
    describe('When reading and folding it as an EWAH stream', () => {
      it('Then it either folds no bit past the unclamped walk’s own highest, or refuses with a closed check', () => {
        // Arrange + Act + Assert
        const sut = readEwahStream;

        // Raw bytes alone almost never survive the header gate, so half the
        // runs start from a VALID encoded stream and corrupt a window of it —
        // the only generation that drives the reader into its overrun gate
        // with in-bounds-looking values.
        const rawBytes = fc
          .uint8Array({ minLength: 0, maxLength: 4096, size: 'max' })
          .chain((bytes) => fc.nat({ max: bytes.length }).map((at) => ({ bytes, at })));

        const corruptedBuilt = fc
          .tuple(arbBitSet(), fc.integer({ min: 0, max: EWAH_BIT_RANGE }))
          .chain(([bits, bitSize]) => {
            const built = encodeEwah(bits, bitSize);
            return fc
              .tuple(
                fc.nat({ max: Math.max(0, built.length - 1) }),
                fc.uint8Array({ minLength: 1, maxLength: 16 }),
              )
              .map(([start, patch]) => {
                const corrupted = built.slice();
                corrupted.set(patch.subarray(0, corrupted.length - start), start);
                return { bytes: corrupted, at: 0 };
              });
          });

        fc.assert(
          fc.property(
            fc.oneof(rawBytes, corruptedBuilt),
            fc.nat({ max: 64 }),
            fc.constantFrom<'or' | 'xor'>('or', 'xor'),
            ({ bytes, at }, destLength, op) => {
              const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
              const into = new Uint32Array(destLength);

              // Captured OUTSIDE the assertions: an expectation thrown inside
              // the try would otherwise be swallowed by this catch and
              // resurface as a confusing refusal-shape failure.
              let folded: { readonly highest: number; readonly walkHighest: number } | undefined;
              let caught: unknown;
              try {
                const stream = sut(bytes, view, at);
                foldEwahStream(bytes, view, stream, into, op);
                folded = {
                  highest: Math.max(...bitsOf(into), -1),
                  walkHighest: maxSetBitPosition(bytes, view, stream),
                };
              } catch (e) {
                caught = e;
              }

              if (folded !== undefined) {
                // The fold is CLAMPED at the destination, the walk is not, so
                // every bit the fold lands must sit at or below the walk's own
                // highest — two independent walks over the same words, one
                // checking the other on content rather than on a length a
                // Uint32Array can never change.
                expect(folded.highest).toBeLessThanOrEqual(folded.walkHighest);
                return;
              }
              const data = (caught as TsgitError).data;
              expect(data.code).toBe('INVALID_PACK_BITMAP');
              if (data.code === 'INVALID_PACK_BITMAP') {
                expect(data.check).toBe('stream');
              }
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
