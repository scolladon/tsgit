import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  hasRacyTimestamp,
  type IndexMtime,
  isEntryStatClean,
  isRacyTimestamp,
  matchesStatData,
} from '../../../../../src/application/primitives/internal/is-entry-stat-clean.js';
import type { IndexEntry } from '../../../../../src/domain/git-index/index-entry.js';
import type { StatCheck } from '../../../../../src/domain/git-index/stat-check.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { FileStat } from '../../../../../src/ports/file-system.js';

const NS_PER_SECOND = 1_000_000_000n;
const U32_MODULUS = 2 ** 32;
const SAMPLE_ID = 'a'.repeat(40) as ObjectId;
const SAMPLE_PATH = 'f.txt' as FilePath;
const ALL: StatCheck = { ctime: true, ownerAndInode: true };
const MINIMAL: StatCheck = { ctime: false, ownerAndInode: false };

const arbSeconds = (): fc.Arbitrary<number> => fc.integer({ min: 1, max: 4_000_000_000 });
const arbNanoseconds = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: 999_999_999 });
// Size 0 on a non-empty blob reads as a smudged entry, never as a measured size.
const arbMeasuredSize = (): fc.Arbitrary<number> => fc.integer({ min: 1, max: 0xff_ff_ff_ff });
const arbU32 = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: 0xff_ff_ff_ff });

interface Seed {
  readonly mtimeSeconds: number;
  readonly mtimeNs: number;
  readonly ctimeSeconds: number;
  readonly ctimeNs: number;
  readonly uid: number;
  readonly gid: number;
  readonly ino: number;
  readonly size: number;
}

const arbSeed = (): fc.Arbitrary<Seed> =>
  fc.record({
    mtimeSeconds: arbSeconds(),
    mtimeNs: arbNanoseconds(),
    ctimeSeconds: arbSeconds(),
    ctimeNs: arbNanoseconds(),
    uid: arbU32(),
    gid: arbU32(),
    ino: arbU32(),
    size: arbMeasuredSize(),
  });

interface CleanFixture {
  readonly entry: IndexEntry;
  readonly stat: FileStat;
  readonly indexMtime: IndexMtime;
}

/** A mutually-agreeing (entry, stat, indexMtime) triple: `isEntryStatClean` is true. */
const buildClean = (seed: Seed): CleanFixture => {
  const entry: IndexEntry = {
    ctimeSeconds: seed.ctimeSeconds,
    ctimeNanoseconds: seed.ctimeNs,
    mtimeSeconds: seed.mtimeSeconds,
    mtimeNanoseconds: seed.mtimeNs,
    dev: 11,
    ino: seed.ino,
    mode: FILE_MODE.REGULAR,
    uid: seed.uid,
    gid: seed.gid,
    fileSize: seed.size,
    id: SAMPLE_ID,
    flags: { assumeValid: false, stage: 0, skipWorktree: false, intentToAdd: false },
    path: SAMPLE_PATH,
  };
  const stat: FileStat = {
    ctimeMs: seed.ctimeSeconds * 1000,
    mtimeMs: seed.mtimeSeconds * 1000,
    dev: 999, // deliberately different — dev is never compared
    ino: seed.ino,
    mode: 0o100644,
    uid: seed.uid,
    gid: seed.gid,
    size: seed.size,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    ctimeNs: BigInt(seed.ctimeSeconds) * NS_PER_SECOND + BigInt(seed.ctimeNs),
    mtimeNs: BigInt(seed.mtimeSeconds) * NS_PER_SECOND + BigInt(seed.mtimeNs),
  };
  // Comfortably later than the entry's mtime — never racy for this fixture.
  const indexMtime: IndexMtime = { seconds: seed.mtimeSeconds + 1_000_000, nanoseconds: 0 };
  return { entry, stat, indexMtime };
};

const bumpNs = (ns: bigint): bigint => {
  const seconds = ns / NS_PER_SECOND;
  const remainder = ns % NS_PER_SECOND;
  return seconds * NS_PER_SECOND + ((remainder + 1n) % NS_PER_SECOND);
};

const bumpNanoseconds = (ns: number): number => (ns + 1) % Number(NS_PER_SECOND);

interface Sides {
  readonly entry: IndexEntry;
  readonly stat: FileStat;
}

const NANOSECOND_MUTATORS: Record<string, (sides: Sides) => Sides> = {
  statMtimeNs: ({ entry, stat }) => ({
    entry,
    stat: { ...stat, mtimeNs: bumpNs(stat.mtimeNs as bigint) },
  }),
  statCtimeNs: ({ entry, stat }) => ({
    entry,
    stat: { ...stat, ctimeNs: bumpNs(stat.ctimeNs as bigint) },
  }),
  entryMtimeNs: ({ entry, stat }) => ({
    entry: { ...entry, mtimeNanoseconds: bumpNanoseconds(entry.mtimeNanoseconds) },
    stat,
  }),
  entryCtimeNs: ({ entry, stat }) => ({
    entry: { ...entry, ctimeNanoseconds: bumpNanoseconds(entry.ctimeNanoseconds) },
    stat,
  }),
};
const NANOSECOND_MUTATOR_NAMES = Object.keys(NANOSECOND_MUTATORS);

const bumpU32 = (n: number): number => (n + 1) % U32_MODULUS;

const STAT_MUTATORS: Record<string, (stat: FileStat) => FileStat> = {
  mtimeSecond: (stat) => ({ ...stat, mtimeMs: stat.mtimeMs + 1000 }),
  ctimeSecond: (stat) => ({ ...stat, ctimeMs: stat.ctimeMs + 1000 }),
  uid: (stat) => ({ ...stat, uid: bumpU32(stat.uid) }),
  gid: (stat) => ({ ...stat, gid: bumpU32(stat.gid) }),
  ino: (stat) => ({ ...stat, ino: bumpU32(stat.ino) }),
  size: (stat) => ({ ...stat, size: bumpU32(stat.size) }),
};
const MUTATOR_NAMES = Object.keys(STAT_MUTATORS);

const arbFileStat = (): fc.Arbitrary<FileStat> =>
  fc
    .record({
      ctimeSeconds: arbSeconds(),
      ctimeNs: arbNanoseconds(),
      mtimeSeconds: arbSeconds(),
      mtimeNs: arbNanoseconds(),
      dev: arbU32(),
      ino: arbU32(),
      uid: arbU32(),
      gid: arbU32(),
      size: arbU32(),
    })
    .map(({ ctimeSeconds, ctimeNs, mtimeSeconds, mtimeNs, ...rest }) => ({
      ...rest,
      ctimeMs: ctimeSeconds * 1000,
      mtimeMs: mtimeSeconds * 1000,
      ctimeNs: BigInt(ctimeSeconds) * NS_PER_SECOND + BigInt(ctimeNs),
      mtimeNs: BigInt(mtimeSeconds) * NS_PER_SECOND + BigInt(mtimeNs),
      mode: 0o100644,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    }));

const arbIndexEntry = (assumeValid: boolean): fc.Arbitrary<IndexEntry> =>
  fc
    .record({
      ctimeSeconds: arbSeconds(),
      ctimeNanoseconds: arbNanoseconds(),
      mtimeSeconds: arbSeconds(),
      mtimeNanoseconds: arbNanoseconds(),
      dev: arbU32(),
      ino: arbU32(),
      uid: arbU32(),
      gid: arbU32(),
      fileSize: arbU32(),
    })
    .map((fields) => ({
      ...fields,
      mode: FILE_MODE.REGULAR,
      id: SAMPLE_ID,
      flags: { assumeValid, stage: 0 as const, skipWorktree: false, intentToAdd: false },
      path: SAMPLE_PATH,
    }));

const arbIndexMtime = (): fc.Arbitrary<IndexMtime> =>
  fc.record({ seconds: arbSeconds(), nanoseconds: arbNanoseconds() });

describe('isEntryStatClean properties', () => {
  describe('Given a mutually-agreeing (entry, stat, indexMtime) triple', () => {
    describe('When exactly one compared whole-second stat field is mutated', () => {
      it('Then it is never clean', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbSeed(), fc.constantFrom(...MUTATOR_NAMES), (seed, mutatorName) => {
            const { entry, stat, indexMtime } = buildClean(seed);
            // Sanity: the unmutated fixture is clean.
            expect(isEntryStatClean(entry, stat, indexMtime, ALL)).toBe(true);

            const mutated = (STAT_MUTATORS[mutatorName] as (s: FileStat) => FileStat)(stat);
            expect(isEntryStatClean(entry, mutated, indexMtime, ALL)).toBe(false);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a non-racy (entry, stat) pair that agrees on every whole second', () => {
    describe('When any nanosecond field of either side changes', () => {
      it('Then isEntryStatClean does not change', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbSeed(),
            fc.constantFrom(...NANOSECOND_MUTATOR_NAMES),
            (seed, mutatorName) => {
              const { entry, stat, indexMtime } = buildClean(seed);
              const mutate = NANOSECOND_MUTATORS[mutatorName] as (sides: Sides) => Sides;
              const mutated = mutate({ entry, stat });
              expect(isEntryStatClean(mutated.entry, mutated.stat, indexMtime, ALL)).toBe(
                isEntryStatClean(entry, stat, indexMtime, ALL),
              );
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an assume-valid entry', () => {
    describe('When checked against an arbitrary, independently-generated stat', () => {
      it('Then it is always clean', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbIndexEntry(true),
            arbFileStat(),
            arbIndexMtime(),
            (entry, stat, indexMtime) => {
              expect(isEntryStatClean(entry, stat, indexMtime, ALL)).toBe(true);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a non-assume-valid entry whose recorded mtime is not provably older than the index mtime', () => {
    describe('When checked against an arbitrary, independently-generated stat', () => {
      it('Then it always defers to read+hash (never clean)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbIndexEntry(false), arbFileStat(), (entry, stat) => {
            const racyIndexMtime: IndexMtime = {
              seconds: entry.mtimeSeconds,
              nanoseconds: entry.mtimeNanoseconds,
            };
            expect(isEntryStatClean(entry, stat, racyIndexMtime, ALL)).toBe(false);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

describe('hasRacyTimestamp properties', () => {
  describe('Given a list of entries and an index mtime', () => {
    describe('When a non-gitlink entry with mtimeSeconds >= index seconds is appended', () => {
      it('Then it is always true', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.array(arbIndexEntry(false), { maxLength: 5 }),
            arbIndexEntry(false),
            arbIndexMtime(),
            fc.integer({ min: 0, max: 1000 }),
            fc.constantFrom(FILE_MODE.REGULAR, FILE_MODE.EXECUTABLE, FILE_MODE.SYMLINK),
            (entries, base, indexMtime, offset, mode) => {
              const racy = { ...base, mode, mtimeSeconds: indexMtime.seconds + offset };
              expect(hasRacyTimestamp([...entries, racy], indexMtime)).toBe(true);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given only gitlink entries, however recent', () => {
    describe('When hasRacyTimestamp', () => {
      it('Then it is false', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.array(arbIndexEntry(false), { maxLength: 5 }),
            arbIndexMtime(),
            (entries, indexMtime) => {
              const gitlinks = entries.map((entry) => ({ ...entry, mode: FILE_MODE.GITLINK }));
              expect(hasRacyTimestamp(gitlinks, indexMtime)).toBe(false);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given only entries strictly older than the index second', () => {
    describe('When hasRacyTimestamp', () => {
      it('Then it is false', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbIndexEntry(false),
            fc.integer({ min: 2, max: 4_000_000_000 }),
            fc.integer({ min: 1, max: 1000 }),
            (entry, seconds, gap) => {
              const older = { ...entry, mtimeSeconds: Math.max(0, seconds - gap) };
              const indexMtime = { seconds, nanoseconds: entry.mtimeNanoseconds };
              expect(hasRacyTimestamp([older], indexMtime)).toBe(false);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

describe('matchesStatData properties', () => {
  describe('Given an (entry, stat) pair that agrees on every whole second', () => {
    describe('When any nanosecond field of either side changes', () => {
      it('Then matchesStatData does not change', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbSeed(),
            fc.constantFrom(...NANOSECOND_MUTATOR_NAMES),
            (seed, mutatorName) => {
              const { entry, stat } = buildClean(seed);
              const mutate = NANOSECOND_MUTATORS[mutatorName] as (sides: Sides) => Sides;
              const mutated = mutate({ entry, stat });
              expect(matchesStatData(mutated.entry, mutated.stat, ALL)).toBe(
                matchesStatData(entry, stat, ALL),
              );
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a policy that compares neither ctime nor owner and inode', () => {
    describe('When the ctime, uid, gid or inode of the stat drifts', () => {
      it('Then matchesStatData does not change', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbSeed(),
            fc.constantFrom('ctimeSecond', 'uid', 'gid', 'ino'),
            (seed, mutatorName) => {
              const { entry, stat } = buildClean(seed);
              const mutated = (STAT_MUTATORS[mutatorName] as (s: FileStat) => FileStat)(stat);
              expect(matchesStatData(entry, mutated, MINIMAL)).toBe(
                matchesStatData(entry, stat, MINIMAL),
              );
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

describe('isRacyTimestamp properties', () => {
  describe('Given an entry and an index mtime', () => {
    describe('When the nanoseconds of either side change', () => {
      it('Then isRacyTimestamp does not change', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbIndexEntry(false),
            arbIndexMtime(),
            arbNanoseconds(),
            arbNanoseconds(),
            (entry, indexMtime, entryNs, indexNs) => {
              const changedEntry = { ...entry, mtimeNanoseconds: entryNs };
              const changedIndex = { ...indexMtime, nanoseconds: indexNs };
              expect(isRacyTimestamp(changedEntry, changedIndex)).toBe(
                isRacyTimestamp(entry, indexMtime),
              );
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
