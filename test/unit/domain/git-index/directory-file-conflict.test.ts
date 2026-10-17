import { describe, expect, it } from 'vitest';
import {
  entriesAtLeadingDirectories,
  entriesBeneath,
} from '../../../../src/domain/git-index/directory-file-conflict.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import type { IndexPathKey } from '../../../../src/domain/git-index/index-path-key.js';
import {
  type IndexPath,
  indexPathKey,
  indexPathOfBytes,
} from '../../../../src/domain/git-index/index-path-key.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const entryOf = (location: IndexPath, stage: 0 | 1 | 2 | 3 = 0): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: 'a'.repeat(40) as ObjectId,
  flags: { ...STAGE0_FLAGS, stage },
  ...location,
});

const at = (path: string, stage: 0 | 1 | 2 | 3 = 0): IndexEntry =>
  entryOf({ path: path as FilePath }, stage);

const pathsOf = (entries: ReadonlyArray<IndexEntry>): string[] =>
  entries.map((e) => `${e.path}@${e.flags.stage}`);

const mapOf = (entries: ReadonlyArray<IndexEntry>): ReadonlyMap<IndexPathKey, IndexEntry> =>
  new Map(entries.map((e) => [indexPathKey(e), e]));

describe('entriesBeneath', () => {
  describe('Given an empty index', () => {
    describe('When asked for a', () => {
      it('Then nothing is returned', () => {
        // Arrange
        const sut = entriesBeneath;

        // Act
        const result = sut([], 'a' as FilePath);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given entries around the slash byte', () => {
    const sorted = [
      at('a'),
      at('a.txt'),
      at('a/b', 1),
      at('a/b', 2),
      at('a/b', 3),
      at('a/c'),
      at('a/x/y'),
      at('ab'),
      at('top'),
    ];

    describe('When asked for a', () => {
      it('Then exactly the entries under a/ are returned in index order', () => {
        // Arrange
        const sut = entriesBeneath;

        // Act
        const result = sut(sorted, 'a' as FilePath);

        // Assert
        expect(pathsOf(result)).toEqual(['a/b@1', 'a/b@2', 'a/b@3', 'a/c@0', 'a/x/y@0']);
      });
    });

    describe('When asked for a nested directory a/x', () => {
      it('Then only a/x/y is returned', () => {
        // Arrange
        const sut = entriesBeneath;

        // Act
        const result = sut(sorted, 'a/x' as FilePath);

        // Assert
        expect(pathsOf(result)).toEqual(['a/x/y@0']);
      });
    });

    describe('When asked for a path with nothing beneath it', () => {
      it('Then nothing is returned', () => {
        // Arrange
        const sut = entriesBeneath;

        // Act
        const result = sut(sorted, 'top' as FilePath);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a lossy entry beneath a', () => {
    describe('When asked for a', () => {
      it('Then the lossy entry is returned', () => {
        // Arrange
        const lossy = entryOf(indexPathOfBytes(Uint8Array.of(0x61, 0x2f, 0xff)));
        const sut = entriesBeneath;

        // Act
        const result = sut([at('a'), lossy, at('b')], 'a' as FilePath);

        // Assert
        expect(result).toEqual([lossy]);
      });
    });
  });
});

describe('entriesAtLeadingDirectories', () => {
  describe('Given stage-0 entries at a and a/x', () => {
    describe('When asked for a/x/y', () => {
      it('Then both leading directories are returned', () => {
        // Arrange
        const sut = entriesAtLeadingDirectories;
        const byKey = mapOf([at('a'), at('a/x'), at('a/x/y')]);

        // Act
        const result = sut(byKey, 'a/x/y' as FilePath);

        // Assert
        expect(pathsOf(result)).toEqual(['a@0', 'a/x@0']);
      });
    });
  });

  describe('Given a top-level path', () => {
    describe('When asked for it', () => {
      it('Then nothing is returned', () => {
        // Arrange
        const sut = entriesAtLeadingDirectories;

        // Act
        const result = sut(mapOf([at('a')]), 'a' as FilePath);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a held only at stage 3', () => {
    describe('When asked for a/b', () => {
      it('Then nothing is returned', () => {
        // Arrange
        const sut = entriesAtLeadingDirectories;

        // Act
        const result = sut(mapOf([at('a', 3)]), 'a/b' as FilePath);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});
