import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { gatherTextStats } from '../../../../src/domain/eol/text-stats.js';

const SUB = 0x1a;

describe('gatherTextStats properties', () => {
  describe('Given any byte sequence', () => {
    describe('When gathered', () => {
      it('Then every byte is counted exactly once', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc
              .array(fc.oneof(fc.integer({ min: 0, max: 255 }), fc.constantFrom(0x0a, 0x0d, SUB)), {
                maxLength: 300,
              })
              .map((b) => Uint8Array.from(b)),
            (bytes) => {
              const sut = gatherTextStats(bytes);
              const discountedSub = bytes.length > 0 && bytes[bytes.length - 1] === SUB ? 1 : 0;
              const counted =
                sut.printable + sut.nonPrintable + 2 * sut.crlf + sut.loneCr + sut.loneLf;
              expect(counted).toBe(bytes.length - discountedSub);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
