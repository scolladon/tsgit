import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  hasRacyTimestamp,
  type IndexMtime,
  isEntryStatClean,
  isRacyTimestamp,
  lstatBeyondLink,
  matchesCachedStat,
  matchesStatData,
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

const MS_PER_SECOND = 1000;
const NS_PER_MS = 1_000_000n;
const U32_MODULUS = 2 ** 32;
const LATE_IN_SECOND_NS = 999_000_000n;

/** The same whole second as `ms`, at a nanosecond no base stamp uses. */
const laterInSecond = (ms: number): bigint => BigInt(ms) * NS_PER_MS + LATE_IN_SECOND_NS;

// Comfortably later than BASE_ENTRY.mtimeSeconds — never racy in the baseline.
const BASE_INDEX_MTIME: IndexMtime = { seconds: 1_700_001_000, nanoseconds: 0 };

const ALL: StatCheck = { ctime: true, ownerAndInode: true };
const NO_CTIME: StatCheck = { ctime: false, ownerAndInode: true };
const MINIMAL: StatCheck = { ctime: false, ownerAndInode: false };

describe('isEntryStatClean', () => {
  describe('Given a stat that matches the entry on every compared field, non-racy', () => {
    describe('When checked', () => {
      it('Then it is clean', () => {
        // Arrange + Act
        const result = isEntryStatClean(BASE_ENTRY, BASE_STAT, BASE_INDEX_MTIME, ALL);

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
        const result = isEntryStatClean(entry, mismatchedStat, BASE_INDEX_MTIME, ALL);

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
        const result = isEntryStatClean(BASE_ENTRY, BASE_STAT, racyIndexMtime, ALL);

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
        const result = isEntryStatClean(BASE_ENTRY, BASE_STAT, racyIndexMtime, ALL);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a differing nanosecond mtime while both sides carry ns precision', () => {
    describe('When checked', () => {
      it('Then it is clean (git compares whole seconds only)', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, mtimeNs: (BASE_STAT.mtimeNs as bigint) + 1n };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME, ALL);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a differing nanosecond ctime while both sides carry ns precision', () => {
    describe('When checked', () => {
      it('Then it is clean (git compares whole seconds only)', () => {
        // Arrange
        const stat: FileStat = { ...BASE_STAT, ctimeNs: (BASE_STAT.ctimeNs as bigint) + 1n };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME, ALL);

        // Assert
        expect(result).toBe(true);
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
        const result = isEntryStatClean(entry, stat, BASE_INDEX_MTIME, ALL);

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
        const result = isEntryStatClean(entry, BASE_STAT, BASE_INDEX_MTIME, ALL);

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
        const result = isEntryStatClean(entry, BASE_STAT, BASE_INDEX_MTIME, ALL);

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
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME, ALL);

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
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME, ALL);

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
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME, ALL);

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
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME, ALL);

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
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME, ALL);

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
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME, ALL);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an entry whose recorded second equals the index mtime second but whose nanosecond strictly precedes it', () => {
    describe('When checked against a matching stat', () => {
      it('Then it is not clean (git compares whole seconds, never nanoseconds)', () => {
        // Arrange
        const indexMtime: IndexMtime = {
          seconds: BASE_ENTRY.mtimeSeconds,
          nanoseconds: BASE_ENTRY.mtimeNanoseconds + 1,
        };

        // Act
        const result = isEntryStatClean(BASE_ENTRY, BASE_STAT, indexMtime, ALL);

        // Assert
        expect(result).toBe(false);
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
        const result = isEntryStatClean(BASE_ENTRY, BASE_STAT, indexMtime, ALL);

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
        const result = isEntryStatClean(BASE_ENTRY, stat, BASE_INDEX_MTIME, ALL);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe.each([
    ['ctime a second later', { ctimeMs: BASE_STAT.ctimeMs + 1000 }, NO_CTIME, true],
    ['ctime a second later', { ctimeMs: BASE_STAT.ctimeMs + 1000 }, ALL, false],
    ['inode', { ino: BASE_STAT.ino + 1 }, MINIMAL, true],
    ['inode', { ino: BASE_STAT.ino + 1 }, ALL, false],
  ] as const)('Given a stat drifted in %s', (_label, drift, check, expected) => {
    describe('When checked under the stat policy', () => {
      it('Then it is clean only when the policy does not compare the drifted field', () => {
        // Arrange
        const stat = { ...BASE_STAT, ...drift } as FileStat;
        const sut = isEntryStatClean;

        // Act
        const result = sut(BASE_ENTRY, stat, BASE_INDEX_MTIME, check);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given an entry recorded with size 0 for a non-empty blob and a stat of size 0', () => {
    describe('When checked and not racy', () => {
      it('Then it is not clean (the size was smudged, not measured)', () => {
        // Arrange
        const entry: IndexEntry = { ...BASE_ENTRY, fileSize: 0 };
        const stat: FileStat = { ...BASE_STAT, size: 0 };
        const sut = isEntryStatClean;

        // Act
        const result = sut(entry, stat, BASE_INDEX_MTIME, ALL);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('isRacyTimestamp', () => {
  const INDEX_SECOND = 946;

  describe.each([
    ['the same second with nanoseconds before the index', INDEX_SECOND, 1, 85_000_000, true],
    ['the same second with nanoseconds 0 against 999999999', INDEX_SECOND, 0, 999_999_999, true],
    ['a second below the index second', INDEX_SECOND - 1, 999_999_999, 0, false],
    ['a second above the index second', INDEX_SECOND + 1, 0, 999_999_999, true],
  ] as const)('Given an entry modified in %s', (_label, seconds, entryNs, indexNs, expected) => {
    describe('When judged against the index mtime', () => {
      it('Then it is racy only when the index second is not after its second', () => {
        // Arrange
        const entry = { ...BASE_ENTRY, mtimeSeconds: seconds, mtimeNanoseconds: entryNs };
        const sut = isRacyTimestamp;

        // Act
        const result = sut(entry, { seconds: INDEX_SECOND, nanoseconds: indexNs });

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a gitlink entry in the index second', () => {
    describe('When judged against the index mtime', () => {
      it('Then it is not racy', () => {
        // Arrange
        const entry = {
          ...BASE_ENTRY,
          mode: FILE_MODE.GITLINK,
          mtimeSeconds: INDEX_SECOND,
          mtimeNanoseconds: 0,
        };
        const sut = isRacyTimestamp;

        // Act
        const result = sut(entry, { seconds: INDEX_SECOND, nanoseconds: 0 });

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an index mtime of second 0', () => {
    describe('When an entry of any second is checked', () => {
      it('Then it is not racy', () => {
        // Arrange
        const entry = { ...BASE_ENTRY, mtimeSeconds: 0, mtimeNanoseconds: 0 };
        const sut = isRacyTimestamp;

        // Act
        const result = sut(entry, { seconds: 0, nanoseconds: 0 });

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
          {
            entry: BASE_ENTRY,
            indexMtime: BASE_INDEX_MTIME,
            executableBit: 'trusted',
            statCheck: ALL,
          },
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
          {
            entry: BASE_ENTRY,
            indexMtime: BASE_INDEX_MTIME,
            executableBit: 'ignored',
            statCheck: ALL,
          },
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
          {
            entry: BASE_ENTRY,
            indexMtime: BASE_INDEX_MTIME,
            executableBit: 'trusted',
            statCheck: ALL,
          },
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
          {
            entry: BASE_ENTRY,
            indexMtime: BASE_INDEX_MTIME,
            executableBit: 'ignored',
            statCheck: ALL,
          },
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
          {
            entry: BASE_ENTRY,
            indexMtime: BASE_INDEX_MTIME,
            executableBit: 'trusted',
            statCheck: ALL,
          },
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
          {
            entry: BASE_ENTRY,
            indexMtime: BASE_INDEX_MTIME,
            executableBit: 'trusted',
            statCheck: ALL,
          },
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
          {
            entry: BASE_ENTRY,
            indexMtime: RACY_INDEX_MTIME,
            executableBit: 'trusted',
            statCheck: ALL,
          },
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

  describe.each([
    ['ctime nanoseconds that drifted', { ctimeNs: laterInSecond(BASE_STAT.ctimeMs) }, ALL],
    ['mtime nanoseconds that drifted', { mtimeNs: laterInSecond(BASE_STAT.mtimeMs) }, ALL],
    [
      'a ctime a second later under a policy ignoring it',
      { ctimeMs: BASE_STAT.ctimeMs + MS_PER_SECOND },
      NO_CTIME,
    ],
    ['an inode that drifted under a policy ignoring it', { ino: BASE_STAT.ino + 1 }, MINIMAL],
  ] as const)('Given a non-racy entry whose stat shows %s', (_label, drift, statCheck) => {
    describe('When judged', () => {
      it('Then it matches without consulting the content', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(false);
        const stat = { ...BASE_STAT, ...drift } as FileStat;
        const sut = matchesCachedStat;

        // Act
        const result = await sut(
          { entry: BASE_ENTRY, indexMtime: BASE_INDEX_MTIME, executableBit: 'trusted', statCheck },
          ABS_PATH,
          stat,
          contentMatches,
        );

        // Assert
        expect(result).toBe(true);
        expect(contentMatches).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a non-racy entry of size 0 holding a non-empty blob', () => {
    describe('When judged against a stat of size 0', () => {
      it('Then it does not match without consulting the content', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(true);
        const entry = { ...BASE_ENTRY, fileSize: 0 };
        const stat: FileStat = { ...BASE_STAT, size: 0 };
        const sut = matchesCachedStat;

        // Act
        const result = await sut(
          { entry, indexMtime: BASE_INDEX_MTIME, executableBit: 'trusted', statCheck: ALL },
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

  describe('Given a matching stat with no index mtime known', () => {
    describe('When judged', () => {
      it('Then the content decides', async () => {
        // Arrange
        const contentMatches = vi.fn().mockResolvedValue(false);

        // Act
        const result = await matchesCachedStat(
          { entry: BASE_ENTRY, indexMtime: undefined, executableBit: 'trusted', statCheck: ALL },
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

describe('matchesStatData', () => {
  describe.each([
    ['nothing drifted', {}, ALL, true],
    ['the nanoseconds of mtime and ctime', { mtimeNs: 1n, ctimeNs: 1n }, ALL, true],
    ['mtime by a second', { mtimeMs: BASE_STAT.mtimeMs + MS_PER_SECOND }, MINIMAL, false],
    ['ctime by a second', { ctimeMs: BASE_STAT.ctimeMs + MS_PER_SECOND }, ALL, false],
    ['ctime by a second', { ctimeMs: BASE_STAT.ctimeMs + MS_PER_SECOND }, NO_CTIME, true],
    ['uid', { uid: BASE_STAT.uid + 1 }, ALL, false],
    ['uid', { uid: BASE_STAT.uid + 1 }, MINIMAL, true],
    ['gid', { gid: BASE_STAT.gid + 1 }, ALL, false],
    ['gid', { gid: BASE_STAT.gid + 1 }, MINIMAL, true],
    ['inode', { ino: BASE_STAT.ino + 1 }, ALL, false],
    ['inode', { ino: BASE_STAT.ino + 1 }, MINIMAL, true],
    ['size', { size: BASE_STAT.size + 1 }, MINIMAL, false],
    [
      'size beyond 32 bits that wraps to the recorded one',
      { size: U32_MODULUS + BASE_STAT.size },
      ALL,
      true,
    ],
    [
      'inode beyond 32 bits that wraps to the recorded one',
      { ino: U32_MODULUS + BASE_STAT.ino },
      ALL,
      true,
    ],
  ] as const)('Given a stat drifted in %s', (_label, drift, check, expected) => {
    describe('When matched against the entry', () => {
      it('Then it matches only when git compares no drifted field', () => {
        // Arrange
        const stat = { ...BASE_STAT, ...drift } as FileStat;
        const sut = matchesStatData;

        // Act
        const result = sut(BASE_ENTRY, stat, check);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  const SHA1_EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
  const SHA256_EMPTY_BLOB = '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813';

  describe.each([
    ['a non-empty blob smudged to size 0', 'a'.repeat(40), 0, false],
    ['the SHA-1 empty blob', SHA1_EMPTY_BLOB, 0, true],
    ['the SHA-256 empty blob', SHA256_EMPTY_BLOB, 0, true],
    ['a non-empty blob of a real size', 'a'.repeat(40), 7, true],
  ] as const)('Given an entry of size 0 or 7 holding %s', (_label, id, size, expected) => {
    describe('When matched against a stat of the same size', () => {
      it('Then it matches unless the entry is racily smudged', () => {
        // Arrange
        const entry = { ...BASE_ENTRY, id: id as ObjectId, fileSize: size };
        const stat = { ...BASE_STAT, size };
        const sut = matchesStatData;

        // Act
        const result = sut(entry, stat, ALL);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
