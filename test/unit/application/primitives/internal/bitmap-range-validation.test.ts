/**
 * Unit tests for bitmap range validation, exercised directly against a
 * hand-built container — no pack, no filesystem. The interesting boundary is
 * the one lane of headroom the validation fold allocates past the object
 * count: a bit set THERE is out of range and past the lane the object count
 * itself ends in, so only the walk over the lanes above that one can see it.
 */
import { describe, expect, it } from 'vitest';
import {
  laneCountFor,
  validateBitmapRanges,
} from '../../../../../src/application/primitives/internal/bitmap-range-validation.js';
import { bitmapEntryHeaders, parsePackBitmap } from '../../../../../src/domain/storage/index.js';
import { type BitmapSpec, buildBitmap } from '../../../domain/storage/arbitraries.js';

const DIGEST_LENGTH = 20;
/** Not a multiple of the 32-bit lane width, so the object count ends INSIDE
 *  lane 0 and the headroom lane above it is reachable only by the tail walk. */
const OBJECT_COUNT = 3;
const HEADROOM_LANE_BIT = 40;

function specWithCommitBits(bits: ReadonlyArray<number>, bitSize: number): BitmapSpec {
  return {
    optionFlags: 0x0001,
    digestLength: DIGEST_LENGTH,
    checksum: new Uint8Array(DIGEST_LENGTH).fill(0xcc),
    typeStreams: [
      { bits, bitSize },
      { bits: [], bitSize: OBJECT_COUNT },
      { bits: [], bitSize: OBJECT_COUNT },
      { bits: [], bitSize: 0 },
    ],
    entries: [],
    trailingBytes: 0,
  };
}

function validate(spec: BitmapSpec): ReturnType<typeof validateBitmapRanges> {
  const bitmap = parsePackBitmap(buildBitmap(spec), DIGEST_LENGTH);
  return validateBitmapRanges(bitmap, bitmapEntryHeaders(bitmap), OBJECT_COUNT);
}

describe('Given bit counts on and around the 32-bit lane boundary', () => {
  describe('When the lane count is computed', () => {
    it.each([
      { bitCount: 0, lanes: 0 },
      { bitCount: 1, lanes: 1 },
      { bitCount: 32, lanes: 1 },
      { bitCount: 33, lanes: 2 },
      { bitCount: 64, lanes: 2 },
      { bitCount: 65, lanes: 3 },
    ])('Then $bitCount bits occupy $lanes lane(s)', ({ bitCount, lanes }) => {
      // Arrange
      const sut = laneCountFor;

      // Act
      const result = sut(bitCount);

      // Assert
      expect(result).toBe(lanes);
    });
  });
});

describe('Given a 3-object artefact whose commits stream sets a bit in the headroom lane above the object count', () => {
  describe('When the ranges are validated', () => {
    it('Then the whole artefact declines — the lanes past the count’s own lane are walked too', () => {
      // Arrange
      const spec = specWithCommitBits([HEADROOM_LANE_BIT], 64);
      const sut = validate;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given a 3-object artefact whose commits stream sets only bits below the object count', () => {
  describe('When the ranges are validated', () => {
    it('Then the artefact validates and the folded commit bits come back truncated to its own lane count', () => {
      // Arrange
      const spec = specWithCommitBits([1], OBJECT_COUNT);
      const sut = validate;

      // Act
      const result = sut(spec);

      // Assert
      expect(result?.typeBits[0]).toEqual(Uint32Array.of(0b10));
    });
  });
});
