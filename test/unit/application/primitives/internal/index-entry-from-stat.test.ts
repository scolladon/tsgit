import { describe, expect, it } from 'vitest';

import { indexEntryFromStat } from '../../../../../src/application/primitives/internal/index-entry-from-stat.js';
import { STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { FileStat } from '../../../../../src/ports/file-system.js';

const stat: FileStat = {
  ctimeMs: 1_700_000_123_456,
  mtimeMs: 1_700_000_987_654,
  dev: 42,
  ino: 99,
  mode: 0o100644,
  uid: 501,
  gid: 20,
  size: 7,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
};

const ID = 'a'.repeat(40) as ObjectId;

describe('Given an lstat result plus a mode, id, and path', () => {
  describe('When building a stage-0 index entry', () => {
    it('Then it copies the stat-cache fields with seconds floored from milliseconds', () => {
      // Arrange + Act
      const result = indexEntryFromStat(stat, FILE_MODE.GITLINK, ID, 'lib' as FilePath);
      // Assert
      expect(result.ctimeSeconds).toBe(1_700_000_123);
      expect(result.mtimeSeconds).toBe(1_700_000_987);
      expect(result.ctimeNanoseconds).toBe(0);
      expect(result.mtimeNanoseconds).toBe(0);
      expect(result.dev).toBe(42);
      expect(result.ino).toBe(99);
      expect(result.uid).toBe(501);
      expect(result.gid).toBe(20);
      expect(result.fileSize).toBe(7);
      expect(result.mode).toBe(FILE_MODE.GITLINK);
      expect(result.id).toBe(ID);
      expect(result.path).toBe('lib');
      expect(result.flags).toBe(STAGE0_FLAGS);
    });
  });
});

describe('Given an lstat result carrying nanosecond-precision timestamps', () => {
  describe('When building a stage-0 index entry', () => {
    it('Then it derives the sub-second remainder from ctimeNs/mtimeNs', () => {
      // Arrange
      const nsStat: FileStat = {
        ...stat,
        ctimeNs: 1_700_000_123_456_789_012n,
        mtimeNs: 1_700_000_987_123_456_789n,
      };

      // Act
      const result = indexEntryFromStat(nsStat, FILE_MODE.REGULAR, ID, 'lib' as FilePath);

      // Assert — the remainder is the ns component within the second, not
      // the full ns-since-epoch value.
      expect(result.ctimeNanoseconds).toBe(456_789_012);
      expect(result.mtimeNanoseconds).toBe(123_456_789);
    });
  });
});
