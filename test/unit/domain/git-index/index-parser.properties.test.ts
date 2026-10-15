import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { GitIndex } from '../../../../src/domain/git-index/index-entry.js';
import { parseIndex } from '../../../../src/domain/git-index/index-parser.js';
import { pathBytesOf } from '../../../../src/domain/git-index/index-path-key.js';
import { compareEntryPath, serializeIndex } from '../../../../src/domain/git-index/index-writer.js';
import { arbGitIndexV2, arbGitIndexV3, arbGitIndexWithPathBytes } from './arbitraries.js';

const CHECKSUM = new Uint8Array(20);

function withChecksum(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + CHECKSUM.length);
  result.set(data, 0);
  result.set(CHECKSUM, data.length);
  return result;
}

function expectedRoundTrip(index: GitIndex): GitIndex {
  // The serialized buffer ends with the 20-byte `CHECKSUM` appended by
  // `withChecksum`. After re-parsing, `trailerSha` reflects those bytes,
  // not the original (empty) arbitrary input — adjust the expected value
  // accordingly so the deep-equal succeeds.
  return {
    version: index.version,
    entries: [...index.entries].sort(compareEntryPath),
    extensions: index.extensions,
    trailerSha: CHECKSUM,
  };
}

describe('index parser properties', () => {
  describe('Given an arbitrary v2 GitIndex (no extended-flag entries)', () => {
    describe('When parseIndex(serializeIndex(index))', () => {
      it('Then it returns the index with entries sorted by path', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbGitIndexV2(), (index) => {
            const result = parseIndex(withChecksum(serializeIndex(index, 20)), 20);
            expect(result).toEqual(expectedRoundTrip(index));
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary v3 GitIndex (≥1 extended-flag entry)', () => {
    describe('When parseIndex(serializeIndex(index))', () => {
      it('Then it returns the index with entries sorted by path', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbGitIndexV3(), (index) => {
            const result = parseIndex(withChecksum(serializeIndex(index, 20)), 20);
            expect(result).toEqual(expectedRoundTrip(index));
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary GitIndex (v2 or v3)', () => {
    describe('When parseIndex(serializeIndex(index))', () => {
      it('Then parsed entry paths are byte-sorted ascending', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(fc.oneof(arbGitIndexV2(), arbGitIndexV3()), (index) => {
            const result = parseIndex(withChecksum(serializeIndex(index, 20)), 20);
            const paths = result.entries.map((e) => e.path as string);
            for (let i = 1; i < paths.length; i++) {
              expect(paths[i - 1]! <= paths[i]!).toBe(true);
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

describe('index raw path bytes round trip', () => {
  describe('Given an arbitrary index whose paths may be raw bytes', () => {
    describe('When serialized, parsed and serialized again', () => {
      it('Then the bytes and every entry path bytes are unchanged', () => {
        fc.assert(
          fc.property(arbGitIndexWithPathBytes(), (index) => {
            // Arrange
            const first = withChecksum(serializeIndex(index, 20));

            // Act
            const sut = parseIndex(first, 20);
            const second = withChecksum(serializeIndex(sut, 20));

            // Assert
            expect(second).toEqual(first);
            const source = new Map(
              index.entries.map((e) => [Buffer.from(pathBytesOf(e)).toString('hex'), e]),
            );
            for (const entry of sut.entries) {
              expect(source.has(Buffer.from(pathBytesOf(entry)).toString('hex'))).toBe(true);
            }
            expect(sut.entries).toHaveLength(index.entries.length);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
