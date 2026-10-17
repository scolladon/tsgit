import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { entriesBeneath } from '../../../../src/domain/git-index/directory-file-conflict.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import {
  indexPathOfBytes,
  isLossy,
  pathBytesOf,
  splitAtSlash,
} from '../../../../src/domain/git-index/index-path-key.js';
import { compareEntryPath } from '../../../../src/domain/git-index/index-writer.js';
import { bytesEqual } from '../../../../src/domain/objects/encoding.js';
import { arbIndexEntryWithPathBytes } from './arbitraries.js';

const NUM_RUNS = 100;
const SLASH = 0x2f;

const startsWithDirectory = (bytes: Uint8Array, directory: Uint8Array): boolean =>
  bytes.length > directory.length &&
  bytes[directory.length] === SLASH &&
  bytesEqual(bytes.subarray(0, directory.length), directory);

describe('entriesBeneath properties', () => {
  describe('Given any sorted entries and a leading directory of one of them', () => {
    it('Then the result equals a linear filter on path bytes', () => {
      fc.assert(
        fc.property(
          fc.array(arbIndexEntryWithPathBytes(), { maxLength: 20 }),
          fc.nat(),
          (entries, pick) => {
            // Arrange
            const sorted = [...entries].sort(compareEntryPath);
            fc.pre(sorted.length > 0);
            const first = splitAtSlash(
              pathBytesOf(sorted[pick % sorted.length] as IndexEntry),
            )[0] as Uint8Array;
            const located = indexPathOfBytes(first);
            fc.pre(!isLossy(located));
            const directoryBytes = first;
            const directory = located.path;
            const sut = entriesBeneath;

            // Act
            const result = sut(sorted, directory);

            // Assert
            const expected = sorted.filter((e) =>
              startsWithDirectory(pathBytesOf(e), directoryBytes),
            );
            expect(result).toEqual(expected);
            for (const entry of result) {
              expect(startsWithDirectory(pathBytesOf(entry), directoryBytes)).toBe(true);
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
