import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  hasRacyTimestamp,
  type IndexMtime,
  isEntryStatClean,
  lstatBeyondLink,
  matchesCachedStat,
  matchesStatFields,
  UNREACHABLE,
} from '../../../../../src/application/primitives/internal/is-entry-stat-clean.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { IndexEntry } from '../../../../../src/domain/git-index/index-entry.js';
import type { StatCheck } from '../../../../../src/domain/git-index/stat-check.js';
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

  describe('Given an entry whose recorded second equals the index mtime second but whose nanosecond strictly precedes it', () => {
    describe('When checked against a matching stat', () => {
      it('Then it is clean (not racy: the second-equal fallthrough compares nanoseconds, not the whole-second boundary)', () => {
        // Arrange
        const indexMtime: IndexMtime = {
          seconds: BASE_ENTRY.mtimeSeconds,
          nanoseconds: BASE_ENTRY.mtimeNanoseconds + 1,
        };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, BASE_STAT, indexMtime);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an entry whose recorded second is strictly newer than the index mtime second, with a nanosecond value that would read as non-racy on its own', () => {
    describe('When checked against a matching stat', () => {
      it('Then it is not clean (the strictly-newer-second short-circuit fires before nanoseconds are ever compared)', () => {
        // Arrange
        const indexMtime: IndexMtime = {
          seconds: BASE_ENTRY.mtimeSeconds - 1,
          nanoseconds: BASE_ENTRY.mtimeNanoseconds + 1,
        };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, BASE_STAT, indexMtime);

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

describe('hasRacyTimestamp', () => {
  const sameSecondIndexMtime: IndexMtime = { seconds: 946, nanoseconds: 85_000_000 };

  describe('Given an entry with mtime 946.0 and an index mtime 946.085', () => {
    describe('When hasRacyTimestamp', () => {
      it('Then it is true because nanoseconds are ignored', () => {
        // Arrange
        const entries = [{ ...BASE_ENTRY, mtimeSeconds: 946, mtimeNanoseconds: 0 }];

        // Act
        const result = hasRacyTimestamp(entries, sameSecondIndexMtime);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given only a gitlink in the same second as the index', () => {
    describe('When hasRacyTimestamp', () => {
      it('Then it is false', () => {
        // Arrange
        const entries = [
          { ...BASE_ENTRY, mode: FILE_MODE.GITLINK, mtimeSeconds: 946, mtimeNanoseconds: 0 },
        ];

        // Act
        const result = hasRacyTimestamp(entries, sameSecondIndexMtime);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an index mtime of second 0', () => {
    describe('When hasRacyTimestamp', () => {
      it('Then it is false', () => {
        // Arrange
        const entries = [{ ...BASE_ENTRY, mtimeSeconds: 0, mtimeNanoseconds: 0 }];

        // Act
        const result = hasRacyTimestamp(entries, { seconds: 0, nanoseconds: 0 });

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('matchesCachedStat', () => {
  const ABS_PATH = '/work/f.txt';
  const RACY_INDEX_MTIME: IndexMtime = { seconds: 1_700_000_100, nanoseconds: 0 };

  describe('Given a stat whose derived mode differs from the entry mode', () => {
    describe('When judged', () => {
      it('Then it is a mismatch without consulting the content', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(true);
        const stat: FileStat = { ...BASE_STAT, mode: 0o100755 };

        // Act
        const result = await matchesCachedStat(
          { entry: BASE_ENTRY, indexMtime: BASE_INDEX_MTIME, executableBit: 'trusted' },
          ABS_PATH,
          stat,
          contentMatches,
        );

        // Assert
        expect(result).toBe(false);
        expect(contentMatches).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a stat that differs from the entry only by the exec bit', () => {
    describe('When the bit is ignored', () => {
      it('Then the cached stat matches', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(false);
        const stat: FileStat = { ...BASE_STAT, mode: 0o100755 };

        // Act
        const result = await matchesCachedStat(
          { entry: BASE_ENTRY, indexMtime: BASE_INDEX_MTIME, executableBit: 'ignored' },
          ABS_PATH,
          stat,
          contentMatches,
        );

        // Assert
        expect(result).toBe(true);
        expect(contentMatches).not.toHaveBeenCalled();
      });
    });

    describe('When the bit is trusted', () => {
      it('Then it does not match', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(false);
        const stat: FileStat = { ...BASE_STAT, mode: 0o100755 };

        // Act
        const result = await matchesCachedStat(
          { entry: BASE_ENTRY, indexMtime: BASE_INDEX_MTIME, executableBit: 'trusted' },
          ABS_PATH,
          stat,
          contentMatches,
        );

        // Assert
        expect(result).toBe(false);
        expect(contentMatches).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a symlink stat for a regular entry', () => {
    describe('When the bit is ignored', () => {
      it('Then it does not match', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(false);
        const stat: FileStat = {
          ...BASE_STAT,
          mode: 0o120000,
          isFile: false,
          isSymbolicLink: true,
        };

        // Act
        const result = await matchesCachedStat(
          { entry: BASE_ENTRY, indexMtime: BASE_INDEX_MTIME, executableBit: 'ignored' },
          ABS_PATH,
          stat,
          contentMatches,
        );

        // Assert
        expect(result).toBe(false);
        expect(contentMatches).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a stat whose size differs from the entry', () => {
    describe('When judged', () => {
      it('Then it is a mismatch without consulting the content', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(true);
        const stat: FileStat = { ...BASE_STAT, size: 8 };

        // Act
        const result = await matchesCachedStat(
          { entry: BASE_ENTRY, indexMtime: BASE_INDEX_MTIME, executableBit: 'trusted' },
          ABS_PATH,
          stat,
          contentMatches,
        );

        // Assert
        expect(result).toBe(false);
        expect(contentMatches).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a matching stat on an entry older than the index', () => {
    describe('When judged', () => {
      it('Then it matches without consulting the content', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(false);

        // Act
        const result = await matchesCachedStat(
          { entry: BASE_ENTRY, indexMtime: BASE_INDEX_MTIME, executableBit: 'trusted' },
          ABS_PATH,
          BASE_STAT,
          contentMatches,
        );

        // Assert
        expect(result).toBe(true);
        expect(contentMatches).not.toHaveBeenCalled();
      });
    });
  });

  describe.each([
    { verdict: true, title: 'the content agrees' },
    { verdict: false, title: 'the content differs' },
  ])('Given a matching stat on a racy entry where $title', ({ verdict }) => {
    describe('When judged', () => {
      it('Then the content verdict is returned', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(verdict);

        // Act
        const result = await matchesCachedStat(
          { entry: BASE_ENTRY, indexMtime: RACY_INDEX_MTIME, executableBit: 'trusted' },
          ABS_PATH,
          BASE_STAT,
          contentMatches,
        );

        // Assert
        expect(result).toBe(verdict);
        expect(contentMatches).toHaveBeenCalledWith(BASE_ENTRY, ABS_PATH, BASE_STAT);
      });
    });
  });

  describe('Given a matching stat with no index mtime known', () => {
    describe('When judged', () => {
      it('Then the content decides', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(false);

        // Act
        const result = await matchesCachedStat(
          { entry: BASE_ENTRY, indexMtime: undefined, executableBit: 'trusted' },
          ABS_PATH,
          BASE_STAT,
          contentMatches,
        );

        // Assert
        expect(result).toBe(false);
        expect(contentMatches).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('lstatBeyondLink', () => {
  describe('Given an absent path', () => {
    describe('When lstatted', () => {
      it('Then it reads as absent', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await lstatBeyondLink(ctx, `${ctx.layout.workDir}/nope`);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a regular file standing as a leading directory', () => {
    describe('When lstatted', () => {
      it('Then it reads as unreachable', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file`, 'x');

        // Act
        const result = await lstatBeyondLink(ctx, `${ctx.layout.workDir}/file/child`);

        // Assert
        expect(result).toBe(UNREACHABLE);
      });
    });
  });

  describe('Given a present path', () => {
    describe('When lstatted', () => {
      it('Then its stat is returned', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file`, 'abc');

        // Act
        const result = await lstatBeyondLink(ctx, `${ctx.layout.workDir}/file`);

        // Assert
        expect(result).toMatchObject({ isFile: true, size: 3 });
      });
    });
  });

  describe('Given an lstat failing for another reason', () => {
    describe('When lstatted', () => {
      it('Then the failure is rethrown', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const failure = new TsgitError({ code: 'PERMISSION_DENIED', path: 'boom' });
        vi.spyOn(ctx.fs, 'tryLstat').mockRejectedValue(failure);

        // Act
        const attempt = lstatBeyondLink(ctx, `${ctx.layout.workDir}/file`);

        // Assert
        await expect(attempt).rejects.toBe(failure);
      });
    });
  });
});

describe('matchesStatFields', () => {
  const ALL: StatCheck = { ctime: true, ownerAndInode: true };
  const NO_CTIME: StatCheck = { ctime: false, ownerAndInode: true };
  const MINIMAL: StatCheck = { ctime: false, ownerAndInode: false };

  describe.each([
    ['nothing drifted', {}, ALL, true],
    ['the nanoseconds of mtime and ctime', { mtimeNs: 1n, ctimeNs: 1n }, ALL, true],
    ['mtime by a second', { mtimeMs: 1_700_000_101_000 }, MINIMAL, false],
    ['ctime by a second', { ctimeMs: 1_700_000_001_000 }, ALL, false],
    ['ctime by a second', { ctimeMs: 1_700_000_001_000 }, NO_CTIME, true],
    ['uid', { uid: 502 }, ALL, false],
    ['uid', { uid: 502 }, MINIMAL, true],
    ['gid', { gid: 21 }, ALL, false],
    ['gid', { gid: 21 }, MINIMAL, true],
    ['inode', { ino: 43 }, ALL, false],
    ['inode', { ino: 43 }, MINIMAL, true],
    ['size', { size: 8 }, MINIMAL, false],
    ['size beyond 32 bits that wraps to the recorded one', { size: 2 ** 32 + 7 }, ALL, true],
    ['inode beyond 32 bits that wraps to the recorded one', { ino: 2 ** 32 + 42 }, ALL, true],
  ] as const)('Given a stat drifted in %s', (_label, drift, check, expected) => {
    describe('When matched against the entry', () => {
      it('Then it matches only when git compares no drifted field', () => {
        // Arrange
        const stat = { ...BASE_STAT, ...drift } as FileStat;
        const sut = matchesStatFields;

        // Act
        const result = sut(BASE_ENTRY, stat, check);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
