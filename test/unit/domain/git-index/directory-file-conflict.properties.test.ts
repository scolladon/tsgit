import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  entriesAtLeadingDirectories,
  entriesBeneath,
} from '../../../../src/domain/git-index/directory-file-conflict.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import {
  type IndexPathKey,
  indexPathOfBytes,
  isLossy,
  keyOfPath,
  pathBytesOf,
  splitAtSlash,
} from '../../../../src/domain/git-index/index-path-key.js';
import { compareEntryPath } from '../../../../src/domain/git-index/index-writer.js';
import { bytesEqual } from '../../../../src/domain/objects/encoding.js';
import type { FilePath } from '../../../../src/domain/objects/index.js';
import { arbIndexEntry, arbIndexEntryWithPathBytes } from './arbitraries.js';

const NUM_RUNS = 100;
const SLASH = 0x2f;

const startsWithDirectory = (bytes: Uint8Array, directory: Uint8Array): boolean =>
  bytes.length > directory.length &&
  bytes[directory.length] === SLASH &&
  bytesEqual(bytes.subarray(0, directory.length), directory);

describe('entriesBeneath properties', () => {
  describe('Given any sorted entries and a leading directory of one of them, When entriesBeneath looks beneath it', () => {
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

type Stage = 0 | 1 | 2 | 3;

const MAX_DEPTH = 5;
const arbSegments = fc.array(fc.constantFrom('a', 'b', 'c'), {
  minLength: 1,
  maxLength: MAX_DEPTH,
});
const arbHeldStage = fc.constantFrom<Stage | undefined>(undefined, 0, 1, 2, 3);

describe('entriesAtLeadingDirectories properties', () => {
  describe('Given any map of entries and a path, When asked for the entries at its leading directories', () => {
    it('Then the result is the stage-0 entries at each proper prefix, in prefix order', () => {
      fc.assert(
        fc.property(
          arbIndexEntry(),
          arbSegments,
          fc.array(arbHeldStage, { minLength: MAX_DEPTH, maxLength: MAX_DEPTH }),
          (template, segments, heldStages) => {
            // Arrange
            const prefixes = segments
              .slice(0, -1)
              .map((_, i) => segments.slice(0, i + 1).join('/'));
            const path = segments.join('/') as FilePath;
            const entryAt = (at: string, stage: Stage): IndexEntry => {
              const { pathBytes: _bytes, ...withoutBytes } = template;
              return { ...withoutBytes, path: at as FilePath, flags: { ...template.flags, stage } };
            };
            const held = prefixes.flatMap((prefix, i) => {
              const stage = heldStages[i];
              return stage === undefined ? [] : [entryAt(prefix, stage)];
            });
            const byKey = new Map<IndexPathKey, IndexEntry>(
              [...held, entryAt(path, 0)].map((entry) => [keyOfPath(entry.path), entry]),
            );
            const sut = entriesAtLeadingDirectories;

            // Act
            const result = sut(byKey, path);

            // Assert
            expect(result).toEqual(held.filter((entry) => entry.flags.stage === 0));
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
