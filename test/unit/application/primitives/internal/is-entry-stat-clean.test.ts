import { describe, expect, it } from 'vitest';
import {
  type IndexMtime,
  isEntryStatClean,
} from '../../../../../src/application/primitives/internal/is-entry-stat-clean.js';
import type { IndexEntry } from '../../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { FileStat } from '../../../../../src/ports/file-system.js';

const BASE_ENTRY: IndexEntry = {
  ctimeSeconds: 1_700_000_000,
  ctimeNanoseconds: 111_000_000,
  mtimeSeconds: 1_700_000_100,
  mtimeNanoseconds: 222_000_000,
  dev: 11,
  ino: 42,
  mode: FILE_MODE.REGULAR,
  uid: 501,
  gid: 20,
  fileSize: 7,
  id: 'a'.repeat(40) as ObjectId,
  flags: { assumeValid: false, stage: 0, skipWorktree: false, intentToAdd: false },
  path: 'f.txt' as FilePath,
};

const BASE_STAT: FileStat = {
  ctimeMs: 1_700_000_000_000,
  mtimeMs: 1_700_000_100_000,
  dev: 11,
  ino: 42,
  mode: 0o100644,
  uid: 501,
  gid: 20,
  size: 7,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
  ctimeNs: 1_700_000_000_111_000_000n,
  mtimeNs: 1_700_000_100_222_000_000n,
};

// Comfortably later than BASE_ENTRY.mtimeSeconds — never racy in the baseline.
const BASE_INDEX_MTIME: IndexMtime = { seconds: 1_700_001_000, nanoseconds: 0 };

describe('isEntryStatClean', () => {
  describe('Given a stat that matches the entry on every compared field, non-racy', () => {
    describe('When checked', () => {
      it('Then it is clean', () => {
        // Arrange + Act
        const result = isEntryStatClean(BASE_ENTRY, BASE_STAT, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an assume-valid entry with a completely mismatched stat', () => {
    describe('When checked', () => {
      it('Then it is clean regardless of the stat (CE_VALID)', () => {
        // Arrange
        const entry: IndexEntry = {
          ...BASE_ENTRY,
          flags: { ...BASE_ENTRY.flags, assumeValid: true },
        };
        const mismatchedStat: FileStat = { ...BASE_STAT, size: 999_999, uid: 0, ino: 0 };

        // Act
        const result = isEntryStatClean(entry, mismatchedStat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an entry whose recorded mtime equals the index file mtime (racy)', () => {
    describe('When checked against an otherwise-matching stat', () => {
      it('Then it is not clean (defers to read+hash)', () => {
        // Arrange
        const racyIndexMtime: IndexMtime = {
          seconds: BASE_ENTRY.mtimeSeconds,
          nanoseconds: BASE_ENTRY.mtimeNanoseconds,
        };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, BASE_STAT, racyIndexMtime);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an entry whose recorded mtime is strictly newer than the index file mtime (racy)', () => {
    describe('When checked against an otherwise-matching stat', () => {
      it('Then it is not clean', () => {
        // Arrange
        const racyIndexMtime: IndexMtime = {
          seconds: BASE_ENTRY.mtimeSeconds - 1,
          nanoseconds: 0,
        };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, BASE_STAT, racyIndexMtime);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a differing nanosecond mtime while both sides carry ns precision', () => {
    describe('When checked', () => {
      it('Then it is not clean', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, mtimeNs: (BASE_STAT.mtimeNs as bigint) + 1n };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a differing nanosecond ctime while both sides carry ns precision', () => {
    describe('When checked', () => {
      it('Then it is not clean', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, ctimeNs: (BASE_STAT.ctimeNs as bigint) + 1n };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a stat with no nanosecond precision (platform without ns support)', () => {
    describe('When checked against an entry with zeroed ns fields, matching seconds only', () => {
      it('Then it is clean (ns comparison is skipped, not defaulted-mismatched)', () => {
        // Arrange
        const entry: IndexEntry = { ...BASE_ENTRY, mtimeNanoseconds: 0, ctimeNanoseconds: 0 };
        const { mtimeNs, ctimeNs, ...withoutNs } = BASE_STAT;
        const stat: FileStat = { ...withoutNs };

        // Act
        const result = isEntryStatClean(entry, stat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an ino that wrapped past 32 bits on the entry side', () => {
    describe('When checked against a stat carrying the low 32 bits', () => {
      it('Then it is clean (ino is compared 32-bit-truncated)', () => {
        // Arrange
        const entry: IndexEntry = { ...BASE_ENTRY, ino: 2 ** 32 + BASE_ENTRY.ino };

        // Act
        const result = isEntryStatClean(entry, BASE_STAT, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a size that wrapped past 32 bits on the entry side', () => {
    describe('When checked against a stat carrying the low 32 bits', () => {
      it('Then it is clean (size is compared 32-bit-truncated)', () => {
        // Arrange
        const entry: IndexEntry = { ...BASE_ENTRY, fileSize: 2 ** 32 + BASE_ENTRY.fileSize };

        // Act
        const result = isEntryStatClean(entry, BASE_STAT, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a stat whose dev differs from the entry', () => {
    describe('When checked', () => {
      it('Then it is still clean (dev is not compared)', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, dev: BASE_STAT.dev + 999 };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a stat whose mtime second differs from the entry, isolated', () => {
    describe('When checked', () => {
      it('Then it is not clean', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, mtimeMs: BASE_STAT.mtimeMs + 1000 };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a stat whose ctime second differs from the entry, isolated', () => {
    describe('When checked', () => {
      it('Then it is not clean', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, ctimeMs: BASE_STAT.ctimeMs + 1000 };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a stat whose uid differs from the entry, isolated', () => {
    describe('When checked', () => {
      it('Then it is not clean', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, uid: BASE_STAT.uid + 1 };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a stat whose gid differs from the entry, isolated', () => {
    describe('When checked', () => {
      it('Then it is not clean', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, gid: BASE_STAT.gid + 1 };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a stat whose ino differs from the entry (within 32 bits), isolated', () => {
    describe('When checked', () => {
      it('Then it is not clean', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, ino: BASE_STAT.ino + 1 };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a stat whose size differs from the entry (within 32 bits), isolated', () => {
    describe('When checked', () => {
      it('Then it is not clean', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, size: BASE_STAT.size + 1 };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
