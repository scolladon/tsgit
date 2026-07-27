import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type IndexMtime,
  isEntryStatClean,
} from '../../../../../src/application/primitives/internal/is-entry-stat-clean.js';
import type { IndexEntry } from '../../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { FileStat } from '../../../../../src/ports/file-system.js';

const NS_PER_SECOND = 1_000_000_000n;
const U32_MODULUS = 2 ** 32;
const SAMPLE_ID = 'a'.repeat(40) as ObjectId;
const SAMPLE_PATH = 'f.txt' as FilePath;

const arbSeconds = (): fc.Arbitrary<number> => fc.integer({ min: 1, max: 4_000_000_000 });
const arbNanoseconds = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: 999_999_999 });
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
    size: arbU32(),
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

const bumpU32 = (n: number): number => (n + 1) % U32_MODULUS;

const STAT_MUTATORS: Record<string, (stat: FileStat) => FileStat> = {
  mtimeSecond: (stat) => ({ ...stat, mtimeMs: stat.mtimeMs + 1000 }),
  ctimeSecond: (stat) => ({ ...stat, ctimeMs: stat.ctimeMs + 1000 }),
  mtimeNs: (stat) => ({ ...stat, mtimeNs: bumpNs(stat.mtimeNs as bigint) }),
  ctimeNs: (stat) => ({ ...stat, ctimeNs: bumpNs(stat.ctimeNs as bigint) }),
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
    describe('When exactly one compared stat field is mutated', () => {
      it('Then it is never clean', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbSeed(), fc.constantFrom(...MUTATOR_NAMES), (seed, mutatorName) => {
            const { entry, stat, indexMtime } = buildClean(seed);
            // Sanity: the unmutated fixture is clean.
            expect(isEntryStatClean(entry, stat, indexMtime)).toBe(true);

            const mutated = (STAT_MUTATORS[mutatorName] as (s: FileStat) => FileStat)(stat);
            expect(isEntryStatClean(entry, mutated, indexMtime)).toBe(false);
          }),
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
              expect(isEntryStatClean(entry, stat, indexMtime)).toBe(true);
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
            expect(isEntryStatClean(entry, stat, racyIndexMtime)).toBe(false);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
