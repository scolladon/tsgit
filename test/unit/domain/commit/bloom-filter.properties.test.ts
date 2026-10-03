import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type BloomFilterSettings,
  bloomKeyHashes,
  changedPathFilter,
  DEFAULT_BLOOM_FILTER_SETTINGS,
  murmur3Seeded,
} from '../../../../src/domain/commit/bloom-filter.js';

const SLASH = 0x2f;
const V2_SETTINGS: BloomFilterSettings = { ...DEFAULT_BLOOM_FILTER_SETTINGS, hashVersion: 2 };

const arbSegment = (maxByte: number): fc.Arbitrary<number[]> =>
  fc.array(
    fc.integer({ min: 1, max: maxByte }).filter((byte) => byte !== SLASH),
    { minLength: 1, maxLength: 6 },
  );

/** A tree path: one or more non-empty segments joined by `/`, no NUL. */
const arbPath = (maxByte: number): fc.Arbitrary<Uint8Array> =>
  fc
    .array(arbSegment(maxByte), { minLength: 1, maxLength: 4 })
    .map((segments) => Uint8Array.from(segments.flatMap((s, i) => (i === 0 ? s : [SLASH, ...s]))));

const arbPaths = (maxByte: number): fc.Arbitrary<Uint8Array[]> =>
  fc.array(arbPath(maxByte), { maxLength: 20 });

const leadingDirectories = (path: Uint8Array): Uint8Array[] =>
  [...path.keys()].filter((i) => path[i] === SLASH).map((i) => path.subarray(0, i));

const bitIsSet = (filter: Uint8Array, hash: number): boolean => {
  const bit = hash % (filter.length * 8);
  return (filter[Math.floor(bit / 8)]! & (1 << (bit % 8))) !== 0;
};

describe('Given an arbitrary byte string without a high bit', () => {
  describe('When hashed under both versions', () => {
    it('Then version 1 and version 2 agree', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ max: 0x7f, maxLength: 40 }),
          fc.integer({ min: 0, max: 0xffffffff }),
          (data, seed) => {
            // Arrange
            const sut = murmur3Seeded;

            // Act
            const result = sut(seed, data, 1);

            // Assert
            expect(result).toBe(sut(seed, data, 2));
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary set of changed paths', () => {
  describe('When the filter is built', () => {
    it('Then every path and every leading directory probes all-set', () => {
      fc.assert(
        fc.property(arbPaths(0xff), (paths) => {
          // Arrange
          const sut = changedPathFilter;

          // Act
          const result = sut(paths, V2_SETTINGS);

          // Assert
          for (const path of paths.flatMap((p) => [p, ...leadingDirectories(p)])) {
            expect(bloomKeyHashes(path, V2_SETTINGS).every((h) => bitIsSet(result, h))).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('Then its length is the distinct path count times bits per entry, in whole bytes', () => {
      fc.assert(
        fc.property(arbPaths(0xff), (paths) => {
          // Arrange
          const sut = changedPathFilter;
          const distinct = new Set(
            paths.flatMap((p) => [p, ...leadingDirectories(p)]).map((p) => p.join(',')),
          );

          // Act
          const result = sut(paths, V2_SETTINGS);

          // Assert
          expect(result).toHaveLength(Math.max(1, Math.ceil((distinct.size * 10) / 8)));
        }),
        { numRuns: 100 },
      );
    });

    it('Then neither order nor repetition changes it', () => {
      fc.assert(
        fc.property(arbPaths(0xff), (paths) => {
          // Arrange
          const sut = changedPathFilter;

          // Act
          const result = sut([...paths].reverse().concat(paths), V2_SETTINGS);

          // Assert
          expect(result).toEqual(sut(paths, V2_SETTINGS));
        }),
        { numRuns: 100 },
      );
    });
  });
});
