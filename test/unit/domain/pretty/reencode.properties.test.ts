import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeToUtf8, encodeFromUtf8 } from '../../../../src/domain/pretty/reencode.js';

const ROUND_TRIP_RUNS = 200;
const MAX_LENGTH = 64;
const SINGLE_BYTE_LABELS = [
  'ISO-8859-1',
  'ISO-8859-2',
  'ISO-8859-15',
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'koi8-r',
  'ibm866',
  'macintosh',
] as const;

describe('Given bytes a single-byte decoder accepts, When decoding then encoding', () => {
  it('Then the original bytes come back', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SINGLE_BYTE_LABELS),
        fc.uint8Array({ maxLength: MAX_LENGTH }),
        (label, bytes) => {
          // Arrange
          const decoded = decodeToUtf8(label, bytes);
          fc.pre(decoded !== undefined);
          const sut = encodeFromUtf8;

          // Act
          const result = sut(label, decoded as Uint8Array);

          // Assert
          expect(result).toEqual(bytes);
        },
      ),
      { numRuns: ROUND_TRIP_RUNS },
    );
  });
});
