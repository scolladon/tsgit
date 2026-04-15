import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexEntry, StatData } from '../../../../src/domain/git-index/index-entry.js';
import { isStatClean } from '../../../../src/domain/git-index/index-entry.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE, FilePath } from '../../../../src/domain/objects/index.js';
import { arbIndexEntry } from './arbitraries.js';

const BASE_ENTRY: IndexEntry = {
  ctimeSeconds: 1000,
  ctimeNanoseconds: 500,
  mtimeSeconds: 2000,
  mtimeNanoseconds: 600,
  dev: 10,
  ino: 20,
  mode: FILE_MODE.REGULAR,
  uid: 100,
  gid: 200,
  fileSize: 4096,
  id: 'a'.repeat(40) as ObjectId,
  flags: { assumeValid: false, extended: false, stage: 0 },
  path: FilePath.from('file.txt'),
};

const BASE_STAT: StatData = {
  ctimeSeconds: 1000,
  ctimeNanoseconds: 500,
  mtimeSeconds: 2000,
  mtimeNanoseconds: 600,
  dev: 10,
  ino: 20,
  mode: FILE_MODE.REGULAR,
  uid: 100,
  gid: 200,
  fileSize: 4096,
};

describe('isStatClean', () => {
  it('Given identical IndexEntry and StatData, When comparing, Then returns true', () => {
    // Arrange & Act
    const sut = isStatClean(BASE_ENTRY, BASE_STAT);

    // Assert
    expect(sut).toBe(true);
  });

  it('Given different mtimeSeconds, When comparing, Then returns false', () => {
    // Arrange
    const stat: StatData = { ...BASE_STAT, mtimeSeconds: 9999 };

    // Act
    const sut = isStatClean(BASE_ENTRY, stat);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given different mtimeNanoseconds, When comparing, Then returns false', () => {
    // Arrange
    const stat: StatData = { ...BASE_STAT, mtimeNanoseconds: 9999 };

    // Act
    const sut = isStatClean(BASE_ENTRY, stat);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given different ctimeSeconds, When comparing, Then returns false', () => {
    // Arrange
    const stat: StatData = { ...BASE_STAT, ctimeSeconds: 9999 };

    // Act
    const sut = isStatClean(BASE_ENTRY, stat);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given different ctimeNanoseconds, When comparing, Then returns false', () => {
    // Arrange
    const stat: StatData = { ...BASE_STAT, ctimeNanoseconds: 9999 };

    // Act
    const sut = isStatClean(BASE_ENTRY, stat);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given different dev, When comparing, Then returns false', () => {
    // Arrange
    const stat: StatData = { ...BASE_STAT, dev: 9999 };

    // Act
    const sut = isStatClean(BASE_ENTRY, stat);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given different ino, When comparing, Then returns false', () => {
    // Arrange
    const stat: StatData = { ...BASE_STAT, ino: 9999 };

    // Act
    const sut = isStatClean(BASE_ENTRY, stat);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given different mode, When comparing, Then returns false', () => {
    // Arrange
    const stat: StatData = { ...BASE_STAT, mode: FILE_MODE.EXECUTABLE };

    // Act
    const sut = isStatClean(BASE_ENTRY, stat);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given different uid, When comparing, Then returns false', () => {
    // Arrange
    const stat: StatData = { ...BASE_STAT, uid: 9999 };

    // Act
    const sut = isStatClean(BASE_ENTRY, stat);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given different gid, When comparing, Then returns false', () => {
    // Arrange
    const stat: StatData = { ...BASE_STAT, gid: 9999 };

    // Act
    const sut = isStatClean(BASE_ENTRY, stat);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given different fileSize, When comparing, Then returns false', () => {
    // Arrange
    const stat: StatData = { ...BASE_STAT, fileSize: 9999 };

    // Act
    const sut = isStatClean(BASE_ENTRY, stat);

    // Assert
    expect(sut).toBe(false);
  });

  describe('property-based tests', () => {
    it('Given any IndexEntry, When extracting stat and comparing, Then isStatClean returns true', () => {
      fc.assert(
        fc.property(arbIndexEntry(), (entry) => {
          const stat: StatData = {
            ctimeSeconds: entry.ctimeSeconds,
            ctimeNanoseconds: entry.ctimeNanoseconds,
            mtimeSeconds: entry.mtimeSeconds,
            mtimeNanoseconds: entry.mtimeNanoseconds,
            dev: entry.dev,
            ino: entry.ino,
            mode: entry.mode,
            uid: entry.uid,
            gid: entry.gid,
            fileSize: entry.fileSize,
          };
          expect(isStatClean(entry, stat)).toBe(true);
        }),
      );
    });

    it('Given any IndexEntry with one numeric field mutated, When comparing, Then isStatClean returns false', () => {
      const numericFields = [
        'ctimeSeconds',
        'ctimeNanoseconds',
        'mtimeSeconds',
        'mtimeNanoseconds',
        'dev',
        'ino',
        'uid',
        'gid',
        'fileSize',
      ] as const;

      fc.assert(
        fc.property(arbIndexEntry(), fc.constantFrom(...numericFields), (entry, field) => {
          const stat: StatData = {
            ctimeSeconds: entry.ctimeSeconds,
            ctimeNanoseconds: entry.ctimeNanoseconds,
            mtimeSeconds: entry.mtimeSeconds,
            mtimeNanoseconds: entry.mtimeNanoseconds,
            dev: entry.dev,
            ino: entry.ino,
            mode: entry.mode,
            uid: entry.uid,
            gid: entry.gid,
            fileSize: entry.fileSize,
            [field]: entry[field] + 1,
          };
          expect(isStatClean(entry, stat)).toBe(false);
        }),
      );
    });
  });
});
