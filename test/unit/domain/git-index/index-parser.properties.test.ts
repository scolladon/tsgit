import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { GitIndex } from '../../../../src/domain/git-index/index-entry.js';
import { parseIndex } from '../../../../src/domain/git-index/index-parser.js';
import { compareEntryPath, serializeIndex } from '../../../../src/domain/git-index/index-writer.js';
import { arbGitIndexV2, arbGitIndexV3 } from './arbitraries.js';

const CHECKSUM = new Uint8Array(20);

function withChecksum(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + CHECKSUM.length);
  result.set(data, 0);
  result.set(CHECKSUM, data.length);
  return result;
}

function expectedRoundTrip(index: GitIndex): GitIndex {
  return {
    version: index.version,
    entries: [...index.entries].sort(compareEntryPath),
    extensions: index.extensions,
  };
}

describe('index parser properties', () => {
  describe('Given an arbitrary v2 GitIndex (no extended-flag entries)', () => {
    describe('When parseIndex(serializeIndex(index))', () => {
      it('Then it returns the index with entries sorted by path', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbGitIndexV2(), (index) => {
            const sut = parseIndex(withChecksum(serializeIndex(index)));
            expect(sut).toEqual(expectedRoundTrip(index));
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
            const sut = parseIndex(withChecksum(serializeIndex(index)));
            expect(sut).toEqual(expectedRoundTrip(index));
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
            const sut = parseIndex(withChecksum(serializeIndex(index)));
            const paths = sut.entries.map((e) => e.path as string);
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
