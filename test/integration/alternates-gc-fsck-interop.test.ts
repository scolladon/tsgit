/**
 * Cross-tool interop — gc over a borrower repository. Each row builds a borrower
 * with real git (`clone --shared`), duplicates it, runs real `git gc` / `repack` /
 * `prune` on one copy and tsgit's gc on the other, then compares the borrower's
 * LOCAL object set and the donor's file set. The comparison reads storage
 * directly (loose fan-out directories, `show-index` of local packs), so
 * borrowed objects never count as local.
 *
 * @proves
 *   surface:        packfile
 *   bucket:         cross-tool-interop
 *   unique:         tsgit gc packs only local objects and prunes against every object source exactly where real git does
 *   interopSurface: packfile
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import { disableAutoMaintenance, GIT_AVAILABLE, runGit } from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const LOCAL_COMMIT_COUNT = 1;
const YEAR_2001_SECONDS = 978_307_200;
const OID_RE = /^[0-9a-f]{40}$/;

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-alt-gc-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Pair {
  readonly donor: string;
  readonly donorObjects: string;
  readonly gitSide: string;
  readonly tsgitSide: string;
}

const configure = (dir: string): void => {
  for (const [key, value] of [
    ['user.name', 'Ada'],
    ['user.email', 'ada@example.com'],
    ['commit.gpgSign', 'false'],
  ] as const) {
    runGit(['-C', dir, 'config', key, value]);
  }
  disableAutoMaintenance(dir);
};

const commitFile = (dir: string, file: string, content: string): void => {
  writeFileSync(path.join(dir, file), content);
  runGit(['-C', dir, 'add', file]);
  runGit(['-C', dir, 'commit', '-q', '-m', `add ${file}`]);
};

const objectsOf = (worktree: string): string => path.join(worktree, '.git', 'objects');

const donorWithPackedHistory = (slug: string): string => {
  const donor = path.join(root, `${slug}-donor`);
  runGit(['init', '-q', '-b', 'main', donor]);
  configure(donor);
  for (const n of [1, 2, 3]) commitFile(donor, `d${n}.txt`, `donor ${n}`);
  runGit(['-C', donor, 'gc', '-q']);
  return donor;
};

/** A borrower with `LOCAL_COMMIT_COUNT` local commits, duplicated into a git side and a tsgit side. */
const pairOf = (slug: string, prepare?: (borrower: string, donor: string) => void): Pair => {
  const donor = donorWithPackedHistory(slug);
  const seed = path.join(root, `${slug}-seed`);
  runGit(['clone', '-q', '--shared', donor, seed]);
  configure(seed);
  for (let n = 0; n < LOCAL_COMMIT_COUNT; n++) commitFile(seed, `local${n}.txt`, `local ${n}`);
  prepare?.(seed, donor);
  const gitSide = path.join(root, `${slug}-git`);
  const tsgitSide = path.join(root, `${slug}-tsgit`);
  cpSync(seed, gitSide, { recursive: true });
  cpSync(seed, tsgitSide, { recursive: true });
  return { donor, donorObjects: objectsOf(donor), gitSide, tsgitSide };
};

const tsgitGc = async (dir: string): Promise<void> => {
  const repo = await openRepository({ cwd: dir });
  await repo.maintenance({ tasks: ['gc'] });
};

const looseOids = (objects: string): ReadonlyArray<string> =>
  readdirSync(objects)
    .filter((name) => /^[0-9a-f]{2}$/.test(name))
    .flatMap((fan) => readdirSync(path.join(objects, fan)).map((rest) => `${fan}${rest}`));

const packIndexes = (objects: string): ReadonlyArray<string> => {
  const packDir = path.join(objects, 'pack');
  if (!existsSync(packDir)) return [];
  return readdirSync(packDir)
    .filter((name) => name.endsWith('.idx'))
    .map((name) => path.join(packDir, name));
};

const packedOids = (objects: string): ReadonlyArray<string> =>
  packIndexes(objects).flatMap((idx) =>
    runGit(['show-index'], { input: readFileSync(idx) })
      .split('\n')
      .map((line) => line.split(' ')[1] ?? '')
      .filter((oid) => OID_RE.test(oid)),
  );

const localObjects = (worktree: string): ReadonlyArray<string> => {
  const objects = objectsOf(worktree);
  return [...new Set([...looseOids(objects), ...packedOids(objects)])].sort();
};

const donorFiles = (donorObjects: string): ReadonlyArray<string> =>
  readdirSync(donorObjects, { recursive: true, encoding: 'utf8' }).sort();

const looseFile = (objects: string, oid: string): string =>
  path.join(objects, oid.slice(0, 2), oid.slice(2));

/** Writes a loose copy by hand: `hash-object -w` would freshen the donor's copy instead. */
const writeLooseCopy = (objects: string, oid: string, blob: string): void => {
  const body = Buffer.from(blob);
  const raw = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
  mkdirSync(path.join(objects, oid.slice(0, 2)), { recursive: true });
  writeFileSync(looseFile(objects, oid), deflateSync(raw));
};

const donorPackedBlob = (donor: string): { readonly oid: string; readonly content: string } => ({
  oid: runGit(['-C', donor, 'rev-parse', 'HEAD:d1.txt']).trim(),
  content: 'donor 1',
});

describe.skipIf(!GIT_AVAILABLE)('alternates gc interop — local-only packing', () => {
  describe('Given a borrower with local commits atop a packed donor history', () => {
    describe('When gc runs on twin copies (G1)', () => {
      it(
        'Then both local object sets are equal and exclude every donor object',
        async () => {
          // Arrange
          const pair = pairOf('g1');
          const sut = tsgitGc;

          // Act
          runGit(['-C', pair.gitSide, 'gc', '-q']);
          await sut(pair.tsgitSide);

          // Assert
          const expected = localObjects(pair.gitSide);
          expect(localObjects(pair.tsgitSide)).toEqual(expected);
          expect(expected).toHaveLength(3 * LOCAL_COMMIT_COUNT);
          const donorOids = new Set(packedOids(pair.donorObjects));
          expect(expected.some((oid) => donorOids.has(oid))).toBe(false);
        },
        ROW_TIMEOUT,
      );
    });

    describe('When git repack -a -d -l runs against tsgit gc (G2)', () => {
      it(
        'Then tsgit gc yields the same local objects as the local-only repack',
        async () => {
          // Arrange
          const pair = pairOf('g2');
          const sut = tsgitGc;

          // Act
          runGit(['-C', pair.gitSide, 'repack', '-a', '-d', '-l', '-q']);
          await sut(pair.tsgitSide);

          // Assert
          expect(localObjects(pair.tsgitSide)).toEqual(localObjects(pair.gitSide));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a donor holding an unreachable loose object', () => {
    describe('When the borrower prunes everything (G3)', () => {
      it(
        'Then the donor file set is untouched by both git and tsgit',
        async () => {
          // Arrange
          const pair = pairOf('g3', (_borrower, donor) => {
            const oid = runGit(['-C', donor, 'hash-object', '-w', '--stdin'], {
              input: 'donor garbage',
            }).trim();
            utimesSync(looseFile(objectsOf(donor), oid), YEAR_2001_SECONDS, YEAR_2001_SECONDS);
          });
          runGit(['-C', pair.tsgitSide, 'config', 'gc.pruneExpire', 'now']);
          const before = donorFiles(pair.donorObjects);
          const sut = tsgitGc;

          // Act
          runGit(['-C', pair.gitSide, 'prune', '--expire=now']);
          runGit(['-C', pair.gitSide, 'gc', '-q', '--prune=now']);
          await sut(pair.tsgitSide);

          // Assert
          expect(donorFiles(pair.donorObjects)).toEqual(before);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a borrower holding a loose copy of a donor-packed object', () => {
    const withLooseCopy = (borrower: string, donor: string): void => {
      const { oid, content } = donorPackedBlob(donor);
      writeLooseCopy(objectsOf(borrower), oid, content);
    };

    describe('When git prune-packed runs against tsgit gc (G4)', () => {
      it(
        'Then both remove the borrower loose copy',
        async () => {
          // Arrange
          const pair = pairOf('g4', withLooseCopy);
          const { oid } = donorPackedBlob(pair.donor);
          const sut = tsgitGc;

          // Act
          runGit(['-C', pair.gitSide, 'prune-packed']);
          await sut(pair.tsgitSide);

          // Assert
          expect(existsSync(looseFile(objectsOf(pair.gitSide), oid))).toBe(false);
          expect(existsSync(looseFile(objectsOf(pair.tsgitSide), oid))).toBe(false);
        },
        ROW_TIMEOUT,
      );
    });

    describe('When gc runs on twin copies (G5)', () => {
      it(
        'Then the loose copy is removed and the local object sets are equal',
        async () => {
          // Arrange
          const pair = pairOf('g5', withLooseCopy);
          const { oid } = donorPackedBlob(pair.donor);
          const sut = tsgitGc;

          // Act
          runGit(['-C', pair.gitSide, 'gc', '-q']);
          await sut(pair.tsgitSide);

          // Assert
          expect(existsSync(looseFile(objectsOf(pair.tsgitSide), oid))).toBe(false);
          expect(localObjects(pair.tsgitSide)).toEqual(localObjects(pair.gitSide));
        },
        ROW_TIMEOUT,
      );
    });
  });
});
