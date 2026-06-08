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
      const sut = indexEntryFromStat(stat, FILE_MODE.GITLINK, ID, 'lib' as FilePath);
      // Assert
      expect(sut.ctimeSeconds).toBe(1_700_000_123);
      expect(sut.mtimeSeconds).toBe(1_700_000_987);
      expect(sut.ctimeNanoseconds).toBe(0);
      expect(sut.mtimeNanoseconds).toBe(0);
      expect(sut.dev).toBe(42);
      expect(sut.ino).toBe(99);
      expect(sut.uid).toBe(501);
      expect(sut.gid).toBe(20);
      expect(sut.fileSize).toBe(7);
      expect(sut.mode).toBe(FILE_MODE.GITLINK);
      expect(sut.id).toBe(ID);
      expect(sut.path).toBe('lib');
      expect(sut.flags).toBe(STAGE0_FLAGS);
    });
  });
});
