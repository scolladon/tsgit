/**
 * Cross-tool interop — gc over a borrower repository. Each row builds a borrower
 * with real git (`clone --shared`), duplicates it, runs real `git gc` / `repack` /
 * `prune` on one copy and tsgit's gc on the other, then compares the borrower's
 * LOCAL object set and the donor's file set. The comparison reads storage
 * directly (loose fan-out directories, `show-index` of local packs), so
 * borrowed objects never count as local.
 *
 * The fsck rows (F) build the same borrower and compare tsgit's structured
 * findings and exit bits with `git fsck` run on the identical on-disk state.
 *
 * @proves
 *   surface:        packfile
 *   bucket:         cross-tool-interop
 *   unique:         tsgit gc packs only local objects and prunes against every object source exactly where real git does
 *   interopSurface: packfile
 */
import {
  chmodSync,
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
import type { FsckFinding, FsckOptions } from '../../src/application/commands/fsck.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const LOCAL_COMMIT_COUNT = 1;
const YEAR_2001_SECONDS = 978_307_200;
const OID_RE = /^[0-9a-f]{40}$/;
const OID_HEX_LENGTH = 40;

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

const indexedOids = (idx: string): ReadonlyArray<string> =>
  runGit(['show-index'], { input: readFileSync(idx) })
    .split('\n')
    .map((line) => line.split(' ')[1] ?? '')
    .filter((oid) => OID_RE.test(oid));

const packedOids = (objects: string): ReadonlyArray<string> =>
  packIndexes(objects).flatMap(indexedOids);

/** Objects in cruft packs only — a cruft pack is the one with an `.mtimes` sidecar. */
const cruftOids = (worktree: string): ReadonlyArray<string> =>
  packIndexes(objectsOf(worktree))
    .filter((idx) => existsSync(idx.replace(/\.idx$/, '.mtimes')))
    .flatMap(indexedOids)
    .sort();

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

  describe('Given a borrower holding unreachable loose objects, one a copy of a donor-packed object', () => {
    const LATER_CONTENT = 'donor later';
    const LOCAL_GARBAGE = 'borrower garbage';

    const withUnreachableCopies = (borrower: string, donor: string): void => {
      commitFile(donor, 'later.txt', LATER_CONTENT);
      runGit(['-C', donor, 'gc', '-q']);
      const later = runGit(['-C', donor, 'rev-parse', 'HEAD:later.txt']).trim();
      writeLooseCopy(objectsOf(borrower), later, LATER_CONTENT);
      runGit(['-C', borrower, 'hash-object', '-w', '--stdin'], { input: LOCAL_GARBAGE });
    };

    describe('When gc runs on twin copies (G6)', () => {
      it(
        'Then the donor-packed copy is dropped and only the local garbage reaches the cruft pack',
        async () => {
          // Arrange
          const pair = pairOf('g6', withUnreachableCopies);
          const later = runGit(['-C', pair.donor, 'rev-parse', 'HEAD:later.txt']).trim();
          const garbage = runGit(['-C', pair.gitSide, 'hash-object', '--stdin'], {
            input: LOCAL_GARBAGE,
          }).trim();
          const sut = tsgitGc;

          // Act
          runGit(['-C', pair.gitSide, 'gc', '-q']);
          await sut(pair.tsgitSide);

          // Assert
          const expected = localObjects(pair.gitSide);
          expect(expected).toContain(garbage);
          expect(expected).not.toContain(later);
          expect(localObjects(pair.tsgitSide)).toEqual(expected);
          expect(cruftOids(pair.gitSide)).toEqual([garbage]);
          expect(cruftOids(pair.tsgitSide)).toEqual([garbage]);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

interface Borrower {
  readonly donor: string;
  readonly borrower: string;
}

const DANGLING_LINE = /^dangling (\w+) ([0-9a-f]{40})$/;

const borrowerOf = (slug: string, packDonor: boolean): Borrower => {
  const donor = path.join(root, `${slug}-donor`);
  runGit(['init', '-q', '-b', 'main', donor]);
  configure(donor);
  for (const n of [1, 2]) commitFile(donor, `d${n}.txt`, `donor ${n}`);
  if (packDonor) runGit(['-C', donor, 'gc', '-q']);
  const borrower = path.join(root, `${slug}-borrower`);
  runGit(['clone', '-q', '--shared', donor, borrower]);
  configure(borrower);
  return { donor, borrower };
};

const unreachableDonorBlob = (donor: string): string =>
  runGit(['-C', donor, 'hash-object', '-w', '--stdin'], { input: 'unreachable blob' }).trim();

const gitFsck = (dir: string, ...flags: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, 'fsck', ...flags]);

const tsgitFsck = async (dir: string, opts: FsckOptions = {}) => {
  const repo = await openRepository({ cwd: dir });
  try {
    return await repo.fsck(opts);
  } finally {
    await repo.dispose();
  }
};

const danglingLines = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
  findings
    .flatMap((f) => (f.type === 'dangling' ? [`dangling ${f.objectType} ${f.id}`] : []))
    .sort();

const gitDanglingLines = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split('\n')
    .filter((line) => DANGLING_LINE.test(line))
    .sort();

const donorPackDir = (donor: string): string => path.join(objectsOf(donor), 'pack');

const MISSING_LINE = /^missing (\w+) ([0-9a-f]{40})$/;

const POINTER_LINE = /^error: \S+: invalid (sha1 pointer|reflog entry) [0-9a-f]{40}$/;

const gitLines = (output: string, line: RegExp): ReadonlyArray<string> =>
  output
    .split('\n')
    .filter((text) => line.test(text))
    .sort();

const missingLines = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
  findings.flatMap((f) => (f.type === 'missing' ? [`missing ${f.objectType} ${f.id}`] : [])).sort();

/** git's ref and reflog pointer errors, rebuilt from tsgit's structured findings. */
const pointerLines = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
  findings
    .flatMap((f) => {
      if (f.type === 'bad-ref' && f.msgId === 'badRefOid') {
        return [`error: ${f.ref}: invalid sha1 pointer ${f.target}`];
      }
      if (f.type === 'invalid-reflog-entry')
        return [`error: ${f.ref}: invalid reflog entry ${f.id}`];
      return [];
    })
    .sort();

/** git's `verify_pack` / open-gate stderr, rebuilt from tsgit's structured pack findings. */
const verifyPackLines = (
  findings: ReadonlyArray<FsckFinding>,
  packDir: string,
): ReadonlyArray<string> =>
  findings.flatMap((f) => {
    const packPath = 'pack' in f ? `${packDir}/${f.pack}.pack` : '';
    switch (f.type) {
      case 'pack-inaccessible':
        return [`error: packfile ${packPath} cannot be accessed`];
      case 'pack-index-checksum-mismatch':
        return [`error: Packfile index for ${packPath} hash mismatch`];
      case 'pack-checksum-mismatch':
        return [`error: ${packPath} pack checksum mismatch`];
      case 'pack-crc-mismatch':
        return [
          `error: index CRC mismatch for object ${f.id} from ${packPath} at offset ${f.offset}`,
        ];
      case 'pack-entry-unpackable':
        return [`error: cannot unpack ${f.id} from ${packPath} at offset ${f.offset}`];
      case 'pack-entry-corrupt':
        return [`error: packed ${f.id} from ${packPath} is corrupt`];
      default:
        return [];
    }
  });

/** The refusal a promise rejects with — fails the row when it resolves. */
const refusalOf = async (
  pending: Promise<unknown>,
): Promise<{ readonly data: { readonly code: string; readonly reason: string } }> => {
  try {
    await pending;
  } catch (error) {
    return error as { readonly data: { readonly code: string; readonly reason: string } };
  }
  throw new Error('expected a refusal');
};

describe.skipIf(!GIT_AVAILABLE)('alternates fsck interop — every source is audited', () => {
  describe('Given a clean --shared borrower holding no local object', () => {
    describe('When fsck runs (F1)', () => {
      it(
        'Then git and tsgit are silent and exit 0',
        async () => {
          // Arrange
          const { borrower } = borrowerOf('f1', true);
          const sut = tsgitFsck;

          // Act
          const gitResult = gitFsck(borrower);
          const result = await sut(borrower);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toBe('');
          expect(result.exitCode).toBe(0);
          expect(result.findings.filter((f) => f.type !== 'root')).toEqual([]);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a donor that gains an unreachable blob', () => {
    describe.each([
      { label: 'default', flags: [] as string[], opts: {} },
      {
        label: 'connectivity-only',
        flags: ['--connectivity-only'],
        opts: { connectivityOnly: true },
      },
    ])('When the borrower fsck runs ($label) (F2)', ({ flags, opts }) => {
      it(
        'Then both report the donor blob as dangling and exit 0',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf(`f2-${flags.length}`, true);
          runGit(['-C', donor, 'hash-object', '-w', '--stdin'], { input: 'unreachable blob' });
          const sut = tsgitFsck;

          // Act
          const gitResult = gitFsck(borrower, ...flags);
          const result = await sut(borrower, opts);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitDanglingLines(gitResult.stdout)).toHaveLength(1);
          expect(danglingLines(result.findings)).toEqual(gitDanglingLines(gitResult.stdout));
          expect(result.exitCode).toBe(0);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a donor commit on a branch the borrower lacks', () => {
    describe('When the borrower fsck runs (F2b)', () => {
      it(
        'Then both report the commit as dangling and the unreachable set matches --unreachable',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf('f2b', true);
          runGit(['-C', donor, 'checkout', '-q', '-b', 'other']);
          commitFile(donor, 'other.txt', 'other');
          const sut = tsgitFsck;

          // Act
          const gitResult = gitFsck(borrower);
          const gitUnreachable = gitFsck(borrower, '--unreachable');
          const result = await sut(borrower);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(danglingLines(result.findings)).toEqual(gitDanglingLines(gitResult.stdout));
          expect(danglingLines(result.findings)[0]).toMatch(/^dangling commit /);
          const unreachableIds = result.findings.flatMap((f) =>
            f.type === 'unreachable' ? [`${f.objectType} ${f.id}`] : [],
          );
          const gitUnreachableIds = gitUnreachable.stdout
            .split('\n')
            .flatMap(
              (line) => /^unreachable (\w+) ([0-9a-f]{40})$/.exec(line)?.slice(1).join(' ') ?? [],
            );
          expect(unreachableIds.sort()).toEqual(gitUnreachableIds.sort());
          expect(result.exitCode).toBe(0);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a donor loose file whose content hashes to a different oid', () => {
    const swapContent = (donor: string): string => {
      const oid = unreachableDonorBlob(donor);
      const file = looseFile(objectsOf(donor), oid);
      const body = Buffer.from('swapped content');
      const raw = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
      rmSync(file);
      writeFileSync(file, deflateSync(raw));
      return oid;
    };

    describe.each([
      { label: 'default', flags: [] as string[], opts: {} },
      { label: 'no-full', flags: ['--no-full'], opts: { full: false } },
    ])('When the borrower fsck runs ($label) (F3)', ({ label, flags, opts }) => {
      it(
        'Then both exit 1 and name the oid and the donor path',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf(`f3-${label}`, false);
          const oid = swapContent(donor);
          const sut = tsgitFsck;

          // Act
          const gitResult = gitFsck(borrower, ...flags);
          const result = await sut(borrower, opts);

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(result.exitCode).toBe(1);
          const mismatch = result.findings.find((f) => f.type === 'hash-mismatch');
          expect(mismatch?.type).toBe('hash-mismatch');
          expect(mismatch?.type === 'hash-mismatch' ? mismatch.id : undefined).toBe(oid);
          const actual = mismatch?.type === 'hash-mismatch' ? mismatch.actual : '';
          const found = looseFile(objectsOf(donor), oid);
          expect(gitResult.stderr).toContain(
            `error: ${actual}: hash-path mismatch, found at: ${found}`,
          );
        },
        ROW_TIMEOUT,
      );
    });

    describe('When the borrower holds its own healthy loose copy of the oid', () => {
      it(
        'Then both still read the donor copy and report its mismatch, exit 1',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf('f3-shadowed', false);
          const oid = swapContent(donor);
          writeLooseCopy(objectsOf(borrower), oid, 'unreachable blob');
          const sut = tsgitFsck;

          // Act
          const gitResult = gitFsck(borrower);
          const result = await sut(borrower);

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(result.exitCode).toBe(1);
          const mismatches = result.findings.filter((f) => f.type === 'hash-mismatch');
          expect(mismatches).toEqual([
            expect.objectContaining({ id: oid, objectsDir: objectsOf(donor) }),
          ]);
          const actual = mismatches[0]?.type === 'hash-mismatch' ? mismatches[0].actual : '';
          expect(gitResult.stderr).toContain(
            `error: ${actual}: hash-path mismatch, found at: ${looseFile(objectsOf(donor), oid)}`,
          );
          expect(danglingLines(result.findings)).toEqual(gitDanglingLines(gitResult.stdout));
        },
        ROW_TIMEOUT,
      );
    });

    describe('When the borrower fsck runs connectivity-only (F3)', () => {
      it(
        'Then both exit 0 and report the same dangling objects',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf('f3-conn', false);
          swapContent(donor);
          const sut = tsgitFsck;

          // Act
          const gitResult = gitFsck(borrower, '--connectivity-only');
          const result = await sut(borrower, { connectivityOnly: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(result.exitCode).toBe(0);
          expect(danglingLines(result.findings)).toEqual(gitDanglingLines(gitResult.stdout));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a donor loose file with a broken zlib stream', () => {
    describe('When the borrower fsck runs (F3b)', () => {
      it(
        'Then both exit 1 and name the donor path',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf('f3b', false);
          const oid = unreachableDonorBlob(donor);
          const file = looseFile(objectsOf(donor), oid);
          rmSync(file);
          writeFileSync(file, Buffer.from('not a zlib stream'));
          const sut = tsgitFsck;

          // Act
          const gitResult = gitFsck(borrower);
          const result = await sut(borrower);

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toContain(`${oid}: object corrupt or missing: ${file}`);
          expect(result.exitCode).toBe(1);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a donor pack', () => {
    const donorPack = (donor: string): string => {
      const dir = path.join(objectsOf(donor), 'pack');
      return path.join(dir, readdirSync(dir).find((name) => name.endsWith('.pack'))!);
    };

    const flipByteAt = (file: string, offset: number): void => {
      const bytes = readFileSync(file);
      bytes[offset] = bytes[offset]! ^ 0xff;
      rmSync(file);
      writeFileSync(file, bytes);
    };

    describe('When a reachable object body is corrupt (F4)', () => {
      it(
        'Then git dies with 128 and tsgit refuses naming the same packed object and pack',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf('f4', true);
          const pack = donorPack(donor);
          flipByteAt(pack, 30);
          const sut = tsgitFsck;

          // Act
          const gitResult = gitFsck(borrower);
          const caught = await refusalOf(sut(borrower));

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(caught.data.code).toBe('INVALID_PACK_ENTRY');
          const named = caught.data.reason.replace(/stored in (\S+)\)/, `stored in ${pack})`);
          expect(gitResult.stderr).toContain(`fatal: ${named}`);
        },
        ROW_TIMEOUT,
      );
    });

    describe('When the pack trailer is corrupt (F4b)', () => {
      it(
        'Then both exit 14 on the donor and the borrower with the missing blobs and invalid pointers git names',
        async () => {
          // Arrange — tsgit's fsck verifies no commit-graph, so the donor's
          // is removed: git's `commit-graph verify` child would add bit 16.
          const { donor, borrower } = borrowerOf('f4b', true);
          rmSync(path.join(objectsOf(donor), 'info', 'commit-graph'), { force: true });
          const pack = donorPack(donor);
          flipByteAt(pack, readFileSync(pack).length - 1);
          const sut = tsgitFsck;

          for (const dir of [donor, borrower]) {
            // Act
            const gitResult = gitFsck(dir);
            const result = await sut(dir);

            // Assert
            const gitPackDir = dir === donor ? '.git/objects/pack' : donorPackDir(donor);
            expect(gitResult.exitCode).toBe(14);
            expect(result.exitCode).toBe(gitResult.exitCode);
            for (const line of verifyPackLines(result.findings, gitPackDir)) {
              expect(gitResult.stderr).toContain(line);
            }
            expect(missingLines(result.findings)).toEqual(gitLines(gitResult.stdout, MISSING_LINE));
            expect(pointerLines(result.findings)).toEqual(gitLines(gitResult.stderr, POINTER_LINE));
          }
        },
        ROW_TIMEOUT,
      );
    });

    const entryOffset = (idx: string, oid: string): number =>
      Number(
        runGit(['show-index'], { input: readFileSync(idx) })
          .split('\n')
          .find((line) => line.split(' ')[1] === oid)
          ?.split(' ')[0],
      );

    const unpackLines = (pack: string, oid: string, offset: number) =>
      [
        `error: ${pack} pack checksum mismatch`,
        `error: index CRC mismatch for object ${oid} from ${pack} at offset ${offset}`,
        `error: cannot unpack ${oid} from ${pack} at offset ${offset}`,
      ].sort();

    const DAMAGE_PAST_ENTRY_START = 4;

    describe('When a second donor pack holds a damaged duplicate of a reachable blob (V4-dup)', () => {
      it(
        'Then both exit 4 on the donor and the borrower and report the damaged copy git reports',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf('v4dup', true);
          const oid = runGit(['-C', donor, 'rev-parse', 'HEAD:d1.txt']).trim();
          const packDir = donorPackDir(donor);
          const name = runGit(['-C', donor, 'pack-objects', path.join(packDir, 'pack')], {
            input: `${oid}\n`,
          }).trim();
          const pack = path.join(packDir, `pack-${name}.pack`);
          const offset = entryOffset(path.join(packDir, `pack-${name}.idx`), oid);
          flipByteAt(pack, offset + DAMAGE_PAST_ENTRY_START);
          const sut = tsgitFsck;

          for (const dir of [donor, borrower]) {
            // Act
            const gitResult = gitFsck(dir);
            const result = await sut(dir);

            // Assert
            const lines = verifyPackLines(result.findings, packDir);
            const gitPackDir = dir === donor ? '.git/objects/pack' : packDir;
            expect(gitResult.exitCode).toBe(4);
            expect(result.exitCode).toBe(4);
            expect([...lines].sort()).toEqual(unpackLines(pack, oid, offset));
            for (const line of verifyPackLines(result.findings, gitPackDir)) {
              expect(gitResult.stderr).toContain(line);
            }
          }
        },
        ROW_TIMEOUT,
      );
    });

    describe('When a loose copy shadows a damaged pack copy of a reachable blob (V4-loose)', () => {
      it(
        'Then both exit 4 on the donor and the borrower and report the hidden pack copy',
        async () => {
          // Arrange
          const donor = path.join(root, 'v4loose-donor');
          runGit(['init', '-q', '-b', 'main', donor]);
          configure(donor);
          for (const n of [1, 2]) commitFile(donor, `d${n}.txt`, `donor ${n}`);
          const oid = runGit(['-C', donor, 'rev-parse', 'HEAD:d1.txt']).trim();
          const loose = path.join(objectsOf(donor), oid.slice(0, 2), oid.slice(2));
          const looseBytes = readFileSync(loose);
          runGit(['-C', donor, 'gc', '-q']);
          mkdirSync(path.dirname(loose), { recursive: true });
          writeFileSync(loose, looseBytes);
          const borrower = path.join(root, 'v4loose-borrower');
          runGit(['clone', '-q', '--shared', donor, borrower]);
          configure(borrower);
          const pack = donorPack(donor);
          const offset = entryOffset(pack.replace(/\.pack$/, '.idx'), oid);
          flipByteAt(pack, offset + DAMAGE_PAST_ENTRY_START);
          const packDir = donorPackDir(donor);
          const sut = tsgitFsck;

          for (const dir of [donor, borrower]) {
            // Act
            const gitResult = gitFsck(dir);
            const result = await sut(dir);

            // Assert
            const gitPackDir = dir === donor ? '.git/objects/pack' : packDir;
            expect(gitResult.exitCode).toBe(4);
            expect(result.exitCode).toBe(4);
            expect([...verifyPackLines(result.findings, packDir)].sort()).toEqual(
              unpackLines(pack, oid, offset),
            );
            for (const line of verifyPackLines(result.findings, gitPackDir)) {
              expect(gitResult.stderr).toContain(line);
            }
          }
        },
        ROW_TIMEOUT,
      );
    });

    describe.each([
      {
        label: 'the tip tree the cache-tree names (V6)',
        slug: 'v6',
        rev: 'HEAD^{tree}',
        modes: ['', '--no-full', '--connectivity-only'],
      },
      { label: 'a non-tip commit (V7)', slug: 'v7', rev: 'HEAD~1', modes: ['--connectivity-only'] },
      {
        label: 'a tree no ref or cache-tree names (V8)',
        slug: 'v8',
        rev: 'HEAD~1^{tree}',
        modes: ['--connectivity-only'],
      },
    ])('When the body of $label is corrupt', ({ slug, rev, modes }) => {
      const OPTIONS: Readonly<Record<string, FsckOptions>> = {
        '': {},
        '--no-full': { full: false },
        '--connectivity-only': { connectivityOnly: true },
      };

      it(
        'Then git dies with 128 and tsgit refuses naming the same packed object, on the donor and the borrower',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf(slug, true);
          rmSync(path.join(objectsOf(donor), 'info', 'commit-graph'), { force: true });
          const oid = runGit(['-C', donor, 'rev-parse', rev]).trim();
          const pack = donorPack(donor);
          const offset = entryOffset(pack.replace(/\.pack$/, '.idx'), oid);
          flipByteAt(pack, offset + DAMAGE_PAST_ENTRY_START);
          const sut = tsgitFsck;

          for (const dir of [donor, borrower]) {
            for (const mode of modes) {
              // Act
              const gitResult = gitFsck(dir, ...(mode === '' ? [] : [mode]));
              const caught = await refusalOf(sut(dir, OPTIONS[mode]));

              // Assert
              expect(gitResult.exitCode).toBe(128);
              expect(caught.data.code).toBe('INVALID_PACK_ENTRY');
              const shown = dir === donor ? path.relative(dir, pack) : pack;
              const named = caught.data.reason.replace(/stored in (\S+)\)/, `stored in ${shown})`);
              expect(gitResult.stderr).toContain(`fatal: ${named}`);
            }
          }
        },
        ROW_TIMEOUT,
      );
    });

    describe('When a separate pack holds only an unreachable object and is corrupt (F4c)', () => {
      it(
        'Then both exit 4 and every verify_pack line git prints is rebuilt from tsgit findings',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf('f4c', true);
          const oid = unreachableDonorBlob(donor);
          const packDir = path.join(objectsOf(donor), 'pack');
          const before = new Set(readdirSync(packDir));
          runGit(['-C', donor, 'pack-objects', path.join(packDir, 'pack')], { input: `${oid}\n` });
          runGit(['-C', donor, 'prune-packed']);
          const added = readdirSync(packDir).find(
            (name) => !before.has(name) && name.endsWith('.pack'),
          )!;
          flipByteAt(path.join(packDir, added), 20);
          const sut = tsgitFsck;

          // Act
          const gitResult = gitFsck(borrower);
          const result = await sut(borrower);

          // Assert
          const lines = verifyPackLines(result.findings, packDir);
          expect(gitResult.exitCode).toBe(4);
          expect(result.exitCode).toBe(4);
          expect([...lines].sort()).toEqual(
            [
              `error: ${packDir}/${added} pack checksum mismatch`,
              `error: index CRC mismatch for object ${oid} from ${packDir}/${added} at offset 12`,
              `error: cannot unpack ${oid} from ${packDir}/${added} at offset 12`,
            ].sort(),
          );
          for (const line of lines) expect(gitResult.stderr).toContain(line);
          expect(danglingLines(result.findings)).toEqual(gitDanglingLines(gitResult.stdout));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a healthy packed donor and its borrower', () => {
    describe('When fsck runs with --no-full (baseline)', () => {
      it(
        'Then both exit 2 with only the invalid reflog entries git names, nothing missing',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf('no-full', true);
          const sut = tsgitFsck;

          for (const dir of [donor, borrower]) {
            // Act
            const gitResult = gitFsck(dir, '--no-full');
            const result = await sut(dir, { full: false });

            // Assert
            expect(gitResult.exitCode).toBe(2);
            expect(result.exitCode).toBe(2);
            expect(pointerLines(result.findings)).toEqual(gitLines(gitResult.stderr, POINTER_LINE));
            expect(missingLines(result.findings)).toEqual(gitLines(gitResult.stdout, MISSING_LINE));
          }
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a donor directory that was removed', () => {
    describe('When the borrower fsck runs (F5)', () => {
      it(
        'Then both fail with the same exit bits',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf('f5', true);
          rmSync(objectsOf(donor), { recursive: true, force: true });
          const sut = tsgitFsck;

          // Act
          const gitResult = gitFsck(borrower);
          const result = await sut(borrower);

          // Assert
          expect(gitResult.exitCode).toBe(10);
          expect(result.exitCode).toBe(gitResult.exitCode);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('alternates gc/fsck interop — loose-only enumeration', () => {
  const BAD_LIMIT = 'bogus';

  const tsgitRefusal = async (dir: string, run: 'fsck' | 'gc') => {
    const repo = await openRepository({ cwd: dir });
    try {
      const pending =
        run === 'fsck' ? repo.fsck({ full: false }) : repo.maintenance({ tasks: ['gc'] });
      return await refusalOf(pending);
    } finally {
      await repo.dispose();
    }
  };

  describe.each([
    { run: 'fsck' as const, gitArgs: ['fsck', '--no-full'] },
    { run: 'gc' as const, gitArgs: ['gc', '-q'] },
  ])('Given a borrower whose core.deltaBaseCacheLimit is malformed', ({ run, gitArgs }) => {
    describe(`When git ${gitArgs.join(' ')} and tsgit ${run} run (L1)`, () => {
      it(
        'Then both refuse with the bad-numeric fatal',
        async () => {
          // Arrange
          const { borrower } = borrowerOf(`l1-${run}`, true);
          runGit(['-C', borrower, 'config', 'core.deltaBaseCacheLimit', BAD_LIMIT]);
          const git = tryRunGitWithExit(['-C', borrower, ...gitArgs]);

          // Act
          const result = await tsgitRefusal(borrower, run);

          // Assert
          const data = result.data as unknown as {
            readonly code: string;
            readonly key: string;
            readonly value: string;
            readonly reason: string;
            readonly source: string;
          };
          const file = path.relative(borrower, data.source);
          expect(git.exitCode).toBe(128);
          expect(git.stderr).toBe(
            `fatal: bad numeric config value '${data.value}' for '${data.key}' in file ${file}: ${data.reason}\n`,
          );
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('fsck interop — deferred .gitmodules checks', () => {
  const EVIL_GITMODULES = '[submodule "x"]\n\tpath = x\n\turl = --upload-pack=evil\n';
  const SPECIAL_MSG_IDS = new Set(['gitmodulesUrl', 'gitmodulesMissing']);
  const SPECIAL_LINE = /^error in (\w+) ([0-9a-f]{40}): (\w+): /;
  const OLDER_SECONDS = YEAR_2001_SECONDS;
  const NEWER_SECONDS = YEAR_2001_SECONDS + 86_400;

  const specialRepo = (slug: string): string => {
    const dir = path.join(root, `special-${slug}`);
    runGit(['init', '-q', '-b', 'main', dir]);
    configure(dir);
    runGit(['-C', dir, 'config', 'gc.writeCommitGraph', 'false']);
    commitFile(dir, '.gitmodules', EVIL_GITMODULES);
    return dir;
  };

  const blobOf = (dir: string): string =>
    runGit(['-C', dir, 'rev-parse', 'HEAD:.gitmodules']).trim();

  const packObjects = (dir: string, oids: ReadonlyArray<string>): string =>
    runGit(['-C', dir, 'pack-objects', '-q', path.join(objectsOf(dir), 'pack', 'pack')], {
      input: `${oids.join('\n')}\n`,
    }).trim();

  const stampPack = (dir: string, name: string, seconds: number): void => {
    for (const ext of ['pack', 'idx', 'rev']) {
      const file = path.join(objectsOf(dir), 'pack', `pack-${name}.${ext}`);
      if (existsSync(file)) utimesSync(file, seconds, seconds);
    }
  };

  /** The blob alone in one pack, everything else in another, each stamped. */
  const splitPacks = (dir: string, blobSeconds: number, restSeconds: number): void => {
    const blob = blobOf(dir);
    const rest = runGit(['-C', dir, 'rev-list', '--objects', 'HEAD'])
      .split('\n')
      .map((line) => line.slice(0, OID_HEX_LENGTH))
      .filter((oid) => OID_RE.test(oid) && oid !== blob);
    stampPack(dir, packObjects(dir, [blob]), blobSeconds);
    stampPack(dir, packObjects(dir, rest), restSeconds);
    runGit(['-C', dir, 'prune-packed']);
  };

  const specialLines = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
    findings.flatMap((finding) =>
      finding.type === 'bad-object' && SPECIAL_MSG_IDS.has(finding.msgId)
        ? [`${finding.objectType} ${finding.id} ${finding.msgId}`]
        : [],
    );

  const gitSpecialLines = (stderr: string): ReadonlyArray<string> =>
    stderr.split('\n').flatMap((line) => {
      const match = SPECIAL_LINE.exec(line);
      return match === null ? [] : [`${match[1]} ${match[2]} ${match[3]}`];
    });

  describe.each([
    { layout: 'loose objects', prepare: (_dir: string) => undefined, exitCode: 1 },
    {
      layout: 'one pack holding the blob before its tree',
      prepare: (dir: string) => runGit(['-C', dir, 'gc', '-q']),
      exitCode: 1,
    },
    {
      layout: 'two packs, the tree pack newer',
      prepare: (dir: string) => splitPacks(dir, OLDER_SECONDS, NEWER_SECONDS),
      exitCode: 4,
    },
    {
      layout: 'two packs, the blob pack newer',
      prepare: (dir: string) => splitPacks(dir, NEWER_SECONDS, OLDER_SECONDS),
      exitCode: 1,
    },
  ])('Given an evil .gitmodules in $layout', ({ layout, prepare, exitCode }) => {
    describe('When git fsck and tsgit fsck run', () => {
      it(
        `Then both report the blob once with exit ${exitCode}`,
        async () => {
          // Arrange
          const dir = specialRepo(layout.replaceAll(/\W+/g, '-'));
          prepare(dir);
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          expect(git.exitCode).toBe(exitCode);
          expect(result.exitCode).toBe(exitCode);
          expect(specialLines(result.findings)).toEqual(gitSpecialLines(git.stderr));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a loose tree naming an evil .gitmodules blob only a pack holds', () => {
    describe.each([
      { flags: [] as ReadonlyArray<string>, opts: {}, exitCode: 4 },
      { flags: ['--no-full'], opts: { full: false }, exitCode: 1 },
    ])('When git fsck $flags and tsgit fsck run', ({ flags, opts, exitCode }) => {
      it(
        `Then both report the blob once with exit ${exitCode}`,
        async () => {
          // Arrange
          const dir = path.join(root, `special-loose-tree${flags.join('')}`);
          runGit(['init', '-q', '-b', 'main', dir]);
          configure(dir);
          const blob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
            input: EVIL_GITMODULES,
          }).trim();
          packObjects(dir, [blob]);
          runGit(['-C', dir, 'prune-packed']);
          runGit(['-C', dir, 'mktree'], { input: `100644 blob ${blob}\t.gitmodules\n` });
          const git = gitFsck(dir, ...flags);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir, opts);

          // Assert
          expect(git.exitCode).toBe(exitCode);
          expect(result.exitCode).toBe(exitCode);
          expect(specialLines(result.findings)).toEqual(gitSpecialLines(git.stderr));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a borrower whose own pack holds the tree and the donor pack the blob', () => {
    describe('When git fsck and tsgit fsck run on the borrower', () => {
      it(
        'Then both meet the borrower pack first and report the donor blob with exit 4',
        async () => {
          // Arrange
          const { donor, borrower } = borrowerOf('special-borrower', true);
          const blob = runGit(['-C', donor, 'hash-object', '-w', '--stdin'], {
            input: EVIL_GITMODULES,
          }).trim();
          packObjects(donor, [blob]);
          runGit(['-C', donor, 'prune-packed']);
          const tree = runGit(['-C', borrower, 'mktree'], {
            input: `100644 blob ${blob}\t.gitmodules\n`,
          }).trim();
          packObjects(borrower, [tree]);
          runGit(['-C', borrower, 'prune-packed']);
          const git = gitFsck(borrower);
          const sut = tsgitFsck;

          // Act
          const result = await sut(borrower);

          // Assert
          expect(git.exitCode).toBe(4);
          expect(result.exitCode).toBe(4);
          expect(specialLines(result.findings)).toEqual(gitSpecialLines(git.stderr));
        },
        ROW_TIMEOUT,
      );
    });
  });

  /** The commit and its tree — every object of `specialRepo`'s one commit but the blob. */
  const commitAndTree = (dir: string): ReadonlyArray<string> => [
    runGit(['-C', dir, 'rev-parse', 'HEAD']).trim(),
    runGit(['-C', dir, 'rev-parse', 'HEAD^{tree}']).trim(),
  ];

  /** The blob packed with fillers until its pack name sorts before `rival`'s. */
  const blobPackSortingBefore = (dir: string, rival: string): string => {
    for (let filler = 0; ; filler += 1) {
      const extra = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
        input: `filler ${filler}`,
      }).trim();
      const name = packObjects(dir, [blobOf(dir), extra]);
      if (name < rival) return name;
      for (const ext of ['pack', 'idx', 'rev']) {
        rmSync(path.join(objectsOf(dir), 'pack', `pack-${name}.${ext}`), { force: true });
      }
    }
  };

  describe.each([
    {
      layout: 'a multi-pack-index blob pack younger than the scanned tree pack',
      prepare: (dir: string) => {
        const blobPack = packObjects(dir, [blobOf(dir)]);
        runGit(['-C', dir, 'multi-pack-index', 'write']);
        const restPack = packObjects(dir, commitAndTree(dir));
        stampPack(dir, blobPack, NEWER_SECONDS);
        stampPack(dir, restPack, OLDER_SECONDS);
      },
      exitCode: 4,
    },
    {
      layout: 'two multi-pack-index packs, the blob pack younger and first by pack-int-id',
      prepare: (dir: string) => {
        const restPack = packObjects(dir, commitAndTree(dir));
        const blobPack = blobPackSortingBefore(dir, restPack);
        runGit(['-C', dir, 'multi-pack-index', 'write']);
        stampPack(dir, blobPack, NEWER_SECONDS);
        stampPack(dir, restPack, OLDER_SECONDS);
      },
      exitCode: 4,
    },
    {
      layout: 'two scanned packs of one age',
      prepare: (dir: string) => splitPacks(dir, OLDER_SECONDS, OLDER_SECONDS),
      exitCode: 4,
    },
    {
      layout: 'two scanned packs of one age and a tag on the blob',
      prepare: (dir: string) => {
        splitPacks(dir, OLDER_SECONDS, OLDER_SECONDS);
        runGit(['-C', dir, 'update-ref', 'refs/tags/blob', blobOf(dir)]);
      },
      exitCode: 1,
    },
  ])('Given an evil .gitmodules in $layout', ({ layout, prepare, exitCode }) => {
    describe('When git fsck and tsgit fsck run', () => {
      it(
        `Then both verify the packs in git's order and exit ${exitCode}`,
        async () => {
          // Arrange
          const dir = specialRepo(layout.replaceAll(/\W+/g, '-'));
          prepare(dir);
          runGit(['-C', dir, 'prune-packed']);
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          expect(git.exitCode).toBe(exitCode);
          expect(result.exitCode).toBe(exitCode);
          expect(specialLines(result.findings)).toEqual(gitSpecialLines(git.stderr));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a borrower whose loose tree copy hashes to another object and a donor holding the valid copy', () => {
    describe('When git fsck and tsgit fsck run on the borrower', () => {
      it(
        'Then both queue the .gitmodules blob from the valid donor copy with exit 1',
        async () => {
          // Arrange
          const donor = specialRepo('corrupt-tree-copy-donor');
          const borrower = path.join(root, 'special-corrupt-tree-copy-borrower');
          runGit(['clone', '-q', '--shared', donor, borrower]);
          configure(borrower);
          rmSync(path.join(borrower, '.git', 'index'));
          const tree = runGit(['-C', borrower, 'rev-parse', 'HEAD^{tree}']).trim();
          const other = 'other\n';
          const treeFile = path.join(objectsOf(borrower), tree.slice(0, 2), tree.slice(2));
          mkdirSync(path.dirname(treeFile), { recursive: true });
          writeFileSync(treeFile, deflateSync(`blob ${other.length}\0${other}`));
          const git = gitFsck(borrower);
          const sut = tsgitFsck;

          // Act
          const result = await sut(borrower);

          // Assert
          expect(git.exitCode).toBe(1);
          expect(result.exitCode).toBe(1);
          expect(specialLines(result.findings)).toEqual(gitSpecialLines(git.stderr));
          expect(specialLines(result.findings)).toEqual([`blob ${blobOf(donor)} gitmodulesUrl`]);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a loose tree naming a .gitmodules blob no store holds', () => {
    describe('When git fsck and tsgit fsck run', () => {
      it(
        'Then both report gitmodulesMissing with exit 1',
        async () => {
          // Arrange
          const dir = path.join(root, 'special-missing');
          runGit(['init', '-q', '-b', 'main', dir]);
          configure(dir);
          const blob = runGit(['-C', dir, 'hash-object', '--stdin'], {
            input: EVIL_GITMODULES,
          }).trim();
          runGit(['-C', dir, 'mktree', '--missing'], {
            input: `100644 blob ${blob}\t.gitmodules\n`,
          });
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          expect(git.exitCode).toBe(1);
          expect(result.exitCode).toBe(1);
          expect(specialLines(result.findings)).toEqual(gitSpecialLines(git.stderr));
          expect(specialLines(result.findings)).toEqual([`blob ${blob} gitmodulesMissing`]);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('fsck/gc interop — index entries', () => {
  const ABSENT_COMMIT = '1111111111111111111111111111111111111111';

  /** A committed repository whose index holds `f` conflicted at stages 1–3. */
  const conflictedRepo = (slug: string): { readonly dir: string; readonly stages: string[] } => {
    const dir = path.join(root, `index-${slug}`);
    runGit(['init', '-q', '-b', 'main', dir]);
    configure(dir);
    commitFile(dir, 'f', 'base');
    const stages = ['one', 'two', 'three'].map((content) =>
      runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: content }).trim(),
    );
    const info = stages.map((oid, at) => `100644 ${oid} ${at + 1}\tf`).join('\n');
    runGit(['-C', dir, 'update-index', '--index-info'], {
      input: `0 ${'0'.repeat(40)}\tf\n${info}\n`,
    });
    return { dir, stages };
  };

  describe('Given an index holding a conflicted path at stages 1, 2 and 3', () => {
    describe('When git fsck and tsgit fsck run', () => {
      it(
        'Then neither reports a stage blob dangling, exit 0',
        async () => {
          // Arrange
          const { dir } = conflictedRepo('fsck-stages');
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          expect(git.exitCode).toBe(0);
          expect(result.exitCode).toBe(0);
          expect(danglingLines(result.findings)).toEqual(gitDanglingLines(git.stdout));
          expect(gitDanglingLines(git.stdout)).toEqual([]);
        },
        ROW_TIMEOUT,
      );
    });

    describe('When git gc and tsgit gc prune everything unreachable', () => {
      it(
        'Then both keep every stage blob',
        async () => {
          // Arrange
          const { dir: gitSide, stages } = conflictedRepo('gc-stages-git');
          const { dir: tsgitSide } = conflictedRepo('gc-stages-tsgit');
          for (const dir of [gitSide, tsgitSide]) {
            runGit(['-C', dir, 'config', 'gc.pruneExpire', 'now']);
          }
          runGit(['-C', gitSide, 'gc', '-q']);
          const sut = tsgitGc;

          // Act
          await sut(tsgitSide);

          // Assert
          for (const oid of stages) {
            expect(tryRunGitWithExit(['-C', gitSide, 'cat-file', '-e', oid]).exitCode).toBe(0);
            expect(tryRunGitWithExit(['-C', tsgitSide, 'cat-file', '-e', oid]).exitCode).toBe(0);
          }
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given an index holding a gitlink to a commit the repository lacks', () => {
    describe('When git fsck and tsgit fsck run', () => {
      it(
        'Then neither reports it missing, exit 0',
        async () => {
          // Arrange
          const dir = path.join(root, 'index-gitlink');
          runGit(['init', '-q', '-b', 'main', dir]);
          configure(dir);
          commitFile(dir, 'f', 'base');
          runGit([
            '-C',
            dir,
            'update-index',
            '--add',
            '--cacheinfo',
            `160000,${ABSENT_COMMIT},sub`,
          ]);
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          expect(git.exitCode).toBe(0);
          expect(result.exitCode).toBe(0);
          expect(missingLines(result.findings)).toEqual(gitLines(git.stdout, MISSING_LINE));
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('fsck interop — every worktree HEAD', () => {
  const ABSENT = '1111111111111111111111111111111111111111';

  /** A main checkout with linked worktrees wt1 and wt2, wt2 one commit ahead. */
  const worktreeRepo = (
    slug: string,
  ): { readonly main: string; readonly wt: (id: string) => string } => {
    const main = path.join(root, `wt-${slug}`);
    runGit(['init', '-q', '-b', 'main', main]);
    configure(main);
    commitFile(main, 'f', 'base');
    const wt = (id: string): string => path.join(root, `wt-${slug}-${id}`);
    for (const id of ['wt1', 'wt2'])
      runGit(['-C', main, 'worktree', 'add', '-q', '--detach', wt(id)]);
    runGit(['-C', wt('wt2'), 'commit', '-q', '--allow-empty', '-m', 'only in wt2']);
    writeFileSync(
      path.join(main, '.git', 'worktrees', path.basename(wt('wt1')), 'HEAD'),
      `${ABSENT}\n`,
    );
    return { main, wt };
  };

  describe.each([
    { from: 'main', bareMainHead: false },
    { from: 'wt1', bareMainHead: false },
    { from: 'wt2', bareMainHead: true },
  ])(
    'Given wt1 HEAD names an absent object (main HEAD absent too: $bareMainHead)',
    ({ from, bareMainHead }) => {
      describe(`When git fsck and tsgit fsck run from ${from}`, () => {
        it(
          'Then both name the same invalid pointers and dangle nothing, exit 2',
          async () => {
            // Arrange
            const { main, wt } = worktreeRepo(`${from}-${bareMainHead}`);
            if (bareMainHead) writeFileSync(path.join(main, '.git', 'HEAD'), `${ABSENT}\n`);
            const dir = from === 'main' ? main : wt(from);
            const git = gitFsck(dir);
            const sut = tsgitFsck;

            // Act
            const result = await sut(dir);

            // Assert
            expect(git.exitCode).toBe(2);
            expect(result.exitCode).toBe(2);
            expect(pointerLines(result.findings)).toEqual(gitLines(git.stderr, POINTER_LINE));
            expect(danglingLines(result.findings)).toEqual(gitDanglingLines(git.stdout));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});

describe.skipIf(!GIT_AVAILABLE)('fsck interop — invalid cache-tree pointers', () => {
  const CACHE_TREE_LINE =
    /^error: ([0-9a-f]{40}): invalid sha1 pointer in cache-tree of \.git\/index$/;

  describe('Given a cache-tree whose subtrees d1 and d2 name trees since deleted', () => {
    describe('When git fsck and tsgit fsck run', () => {
      it(
        'Then both name each absent oid in cache-tree order, exit 10',
        async () => {
          // Arrange
          const dir = path.join(root, 'cache-tree-pointers');
          runGit(['init', '-q', '-b', 'main', dir]);
          configure(dir);
          for (const sub of ['d1', 'd2']) {
            mkdirSync(path.join(dir, sub));
            writeFileSync(path.join(dir, sub, 'f'), sub);
          }
          commitFile(dir, 'c', 'c');
          runGit(['-C', dir, 'add', '.']);
          runGit(['-C', dir, 'commit', '-q', '-m', 'subtrees']);
          runGit(['-C', dir, 'write-tree']);
          for (const sub of ['d1', 'd2']) {
            const oid = runGit(['-C', dir, 'rev-parse', `HEAD^{tree}:${sub}`]).trim();
            rmSync(looseFile(objectsOf(dir), oid));
          }
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          const gitOids = git.stderr.split('\n').flatMap((line) => {
            const match = CACHE_TREE_LINE.exec(line);
            return match === null ? [] : [match[1]];
          });
          expect(git.exitCode).toBe(10);
          expect(result.exitCode).toBe(10);
          expect(gitOids).toHaveLength(2);
          expect(
            result.findings.flatMap((f) => (f.type === 'invalid-cache-tree-pointer' ? [f.id] : [])),
          ).toEqual(gitOids);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('fsck interop — symbolic refs naming no object', () => {
  describe.each([
    { label: 'an unborn branch', target: undefined },
    { label: 'a branch naming an absent object', target: '1'.repeat(40) },
  ])('Given refs/remotes/origin/HEAD pointing at $label', ({ label, target }) => {
    describe('When git fsck and tsgit fsck run', () => {
      it(
        'Then both name the same invalid pointers, exit 2',
        async () => {
          // Arrange
          const dir = path.join(root, `symref-${label.replaceAll(/\W+/g, '-')}`);
          runGit(['init', '-q', '-b', 'main', dir]);
          configure(dir);
          commitFile(dir, 'f', 'base');
          runGit([
            '-C',
            dir,
            'symbolic-ref',
            'refs/remotes/origin/HEAD',
            'refs/remotes/origin/main',
          ]);
          if (target !== undefined) {
            mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
            writeFileSync(
              path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main'),
              `${target}\n`,
            );
          }
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          expect(git.exitCode).toBe(2);
          expect(result.exitCode).toBe(2);
          expect(pointerLines(result.findings)).toEqual(gitLines(git.stderr, POINTER_LINE));
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('fsck interop — worktree admin entries git skips', () => {
  describe.each([
    { label: 'empty', spoil: (gitdir: string) => writeFileSync(gitdir, '') },
    { label: 'unreadable', spoil: (gitdir: string) => chmodSync(gitdir, 0o000) },
  ])(
    'Given a linked worktree whose gitdir file is $label and whose HEAD names an absent object',
    ({ label, spoil }) => {
      describe('When git fsck and tsgit fsck run from the main worktree', () => {
        it(
          'Then both treat the worktree alike',
          async () => {
            // Arrange
            const main = path.join(root, `wt-gitdir-${label}`);
            const linked = `${main}-linked`;
            runGit(['init', '-q', '-b', 'main', main]);
            configure(main);
            commitFile(main, 'f', 'base');
            runGit(['-C', main, 'worktree', 'add', '-q', '--detach', linked]);
            const admin = path.join(main, '.git', 'worktrees', path.basename(linked));
            writeFileSync(path.join(admin, 'HEAD'), `${'1'.repeat(40)}\n`);
            spoil(path.join(admin, 'gitdir'));
            const git = gitFsck(main);
            const sut = tsgitFsck;

            // Act
            const result = await sut(main);

            // Assert
            chmodSync(path.join(admin, 'gitdir'), 0o644);
            expect(result.exitCode).toBe(git.exitCode);
            expect(pointerLines(result.findings)).toEqual(gitLines(git.stderr, POINTER_LINE));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});

/** Whether `oid` is still stored in `dir` (loose or packed). */
const holdsObject = (dir: string, oid: string): boolean =>
  tryRunGitWithExit(['-C', dir, 'cat-file', '-e', oid]).exitCode === 0;

/** Make `file` removable again when the run left it in place (git's own
 *  `gc` deletes a worktree admin dir whose `gitdir` it cannot use). */
const restoreMode = (file: string): void => {
  if (existsSync(file)) chmodSync(file, 0o755);
};

/** Twin copies of `seed`: real git runs on one, tsgit on the other. */
const twinsOf = (seed: string): { readonly gitSide: string; readonly tsgitSide: string } => {
  const gitSide = `${seed}-git`;
  const tsgitSide = `${seed}-tsgit`;
  cpSync(seed, gitSide, { recursive: true });
  cpSync(seed, tsgitSide, { recursive: true });
  runGit(['-C', tsgitSide, 'config', 'gc.pruneExpire', 'now']);
  return { gitSide, tsgitSide };
};

const UNOPENABLE_SPOILS = [
  { label: 'mode 000', spoil: (file: string) => chmodSync(file, 0o000) },
  {
    label: 'a directory',
    spoil: (file: string) => {
      rmSync(file);
      mkdirSync(file);
    },
  },
] as const;

const PRUNING_GIT_COMMANDS = [
  { label: 'git gc --prune=now', args: ['gc', '-q', '--prune=now'] },
  { label: 'git prune --expire=now', args: ['prune', '--expire=now'] },
] as const;

describe.skipIf(!GIT_AVAILABLE)('gc interop — reads git treats as absent', () => {
  describe.each(UNOPENABLE_SPOILS)(
    'Given a commit only a reflog names, that reflog being $label',
    ({ label, spoil }) => {
      describe.each(PRUNING_GIT_COMMANDS)('When $label and tsgit gc run', ({ args }) => {
        it(
          'Then both prune or keep the commit alike',
          async () => {
            // Arrange
            const seed = path.join(
              root,
              `unopenable-reflog-${label}-${args[0]}`.replace(/ /g, '-'),
            );
            runGit(['init', '-q', '-b', 'main', seed]);
            configure(seed);
            commitFile(seed, 'f', 'base');
            const orphan = runGit([
              '-C',
              seed,
              'commit-tree',
              '-m',
              'orphan',
              'HEAD^{tree}',
            ]).trim();
            runGit(['-C', seed, 'update-ref', 'refs/heads/side', orphan]);
            runGit(['-C', seed, 'update-ref', 'refs/heads/side', 'HEAD']);
            const { gitSide, tsgitSide } = twinsOf(seed);
            const reflogOf = (dir: string): string =>
              path.join(dir, '.git', 'logs', 'refs', 'heads', 'side');
            spoil(reflogOf(gitSide));
            spoil(reflogOf(tsgitSide));
            runGit(['-C', gitSide, ...args]);
            const sut = tsgitGc;

            // Act
            await sut(tsgitSide);

            // Assert
            restoreMode(reflogOf(gitSide));
            restoreMode(reflogOf(tsgitSide));
            expect(holdsObject(tsgitSide, orphan)).toBe(holdsObject(gitSide, orphan));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );

  describe.each([
    ...UNOPENABLE_SPOILS,
    { label: 'empty', spoil: (file: string) => writeFileSync(file, '') },
  ])(
    'Given a commit only a linked worktree HEAD names, its gitdir file being $label',
    ({ label, spoil }) => {
      describe('When git gc --prune=now and tsgit gc run', () => {
        it(
          'Then both prune or keep the commit alike',
          async () => {
            // Arrange
            const seed = path.join(root, `unopenable-gitdir-${label}`.replace(/ /g, '-'));
            runGit(['init', '-q', '-b', 'main', seed]);
            configure(seed);
            commitFile(seed, 'f', 'base');
            const detached = runGit(['-C', seed, 'commit-tree', '-m', 'wt', 'HEAD^{tree}']).trim();
            runGit(['-C', seed, 'worktree', 'add', '-q', '--detach', `${seed}-linked`, detached]);
            runGit(['-C', seed, 'reflog', 'expire', '--expire=now', '--all']);
            const { gitSide, tsgitSide } = twinsOf(seed);
            const gitdirOf = (dir: string): string =>
              path.join(dir, '.git', 'worktrees', path.basename(`${seed}-linked`), 'gitdir');
            spoil(gitdirOf(gitSide));
            spoil(gitdirOf(tsgitSide));
            runGit(['-C', gitSide, 'gc', '-q', '--prune=now']);
            const sut = tsgitGc;

            // Act
            await sut(tsgitSide);

            // Assert
            restoreMode(gitdirOf(gitSide));
            restoreMode(gitdirOf(tsgitSide));
            expect(holdsObject(tsgitSide, detached)).toBe(holdsObject(gitSide, detached));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});

describe.skipIf(!GIT_AVAILABLE)('fsck interop — a reflog it cannot open', () => {
  describe.each(UNOPENABLE_SPOILS)(
    'Given a commit only a reflog names, that reflog being $label',
    ({ label, spoil }) => {
      describe('When git fsck and tsgit fsck run', () => {
        it(
          'Then both exit alike and agree on whether the commit dangles',
          async () => {
            // Arrange
            const dir = path.join(root, `fsck-unopenable-reflog-${label}`.replace(/ /g, '-'));
            runGit(['init', '-q', '-b', 'main', dir]);
            configure(dir);
            commitFile(dir, 'f', 'base');
            const orphan = runGit(['-C', dir, 'commit-tree', '-m', 'orphan', 'HEAD^{tree}']).trim();
            runGit(['-C', dir, 'update-ref', 'refs/heads/side', orphan]);
            runGit(['-C', dir, 'update-ref', 'refs/heads/side', 'HEAD']);
            const reflog = path.join(dir, '.git', 'logs', 'refs', 'heads', 'side');
            spoil(reflog);
            const git = gitFsck(dir);
            const sut = tsgitFsck;

            // Act
            const result = await sut(dir);

            // Assert
            restoreMode(reflog);
            const dangles = result.findings.some((f) => f.type === 'dangling' && f.id === orphan);
            expect(result.exitCode).toBe(git.exitCode);
            expect(dangles).toBe(git.stdout.includes(`dangling commit ${orphan}`));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});

describe.skipIf(!GIT_AVAILABLE)('fsck interop — names git reads as a special file', () => {
  const EVIL_GITMODULES = '[submodule "x"]\n\tpath = x\n\turl = -evil\n';
  const REPORT_LINE = /^(?:error|warning) in (\w+) ([0-9a-f]{40}): (\w+): /;

  /** git's `<level> in <type> <oid>: <msg-id>` lines, rebuilt from tsgit's findings. */
  const reportLines = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
    findings.flatMap((finding) =>
      finding.type === 'bad-object' ? [`${finding.objectType} ${finding.id} ${finding.msgId}`] : [],
    );

  const gitReportLines = (stderr: string): ReadonlyArray<string> =>
    stderr.split('\n').flatMap((line) => {
      const match = REPORT_LINE.exec(line);
      return match === null ? [] : [`${match[1]} ${match[2]} ${match[3]}`];
    });

  /** A tree of one `mode` entry named `name` (raw UTF-8 bytes) pointing at `oid`. */
  const writeRawTree = (dir: string, mode: string, name: string, oid: string): string =>
    runGit(['-C', dir, 'hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], {
      input: Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'utf8'), Buffer.from(oid, 'hex')]),
    }).trim();

  describe.each([
    '.gitmodules',
    '.GITMODULES',
    'gitmod~1',
    'GI7EBA~2',
    'gi7eb~12',
    '.gitmodules. .',
    '.gitmodules:stream',
    '.git‌modules',
    'a\\.gitmodules',
    'a\\gitmod~1',
    'a\\.git‌modules',
    'a\\.gitmodules\\b',
    'gitmod~5',
    '.git:stream',
    'a\\.git',
    'a\\git~1\\b',
  ])('Given a tree naming an evil .gitmodules blob as %j', (name) => {
    describe.each(['100644', '120000'])('When the entry mode is %s', (mode) => {
      it(
        'Then git fsck and tsgit fsck report alike',
        async () => {
          // Arrange
          const slug = Buffer.from(`${name}-${mode}`).toString('hex');
          const dir = path.join(root, `special-name-${slug}`);
          runGit(['init', '-q', '-b', 'main', dir]);
          configure(dir);
          const blob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
            input: EVIL_GITMODULES,
          }).trim();
          writeRawTree(dir, mode, name, blob);
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          expect(result.exitCode).toBe(git.exitCode);
          expect(reportLines(result.findings)).toEqual(gitReportLines(git.stderr));
        },
        ROW_TIMEOUT,
      );
    });
  });

  const writeBlob = (dir: string, content: string): string =>
    runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: content }).trim();

  const absentOid = (dir: string, content: string): string =>
    runGit(['-C', dir, 'hash-object', '--stdin'], { input: content }).trim();

  const LONG_ATTRIBUTES_LINE = `# ${'a'.repeat(3000)}\n`;

  describe.each([
    {
      state: 'a blob',
      store: (dir: string) => writeBlob(dir, `${EVIL_GITMODULES}${LONG_ATTRIBUTES_LINE}`),
    },
    {
      state: 'absent',
      store: (dir: string) => absentOid(dir, `${EVIL_GITMODULES}${LONG_ATTRIBUTES_LINE}`),
    },
    {
      state: 'a tree',
      store: (dir: string) => runGit(['-C', dir, 'mktree'], { input: '' }).trim(),
    },
  ])(
    'Given one object named .gitmodules by one tree and .gitattributes by another, the object being $state',
    ({ state, store }) => {
      describe('When git fsck and tsgit fsck run', () => {
        it(
          'Then both check it under both names alike',
          async () => {
            // Arrange
            const dir = path.join(root, `special-both-names-${state.replace(/ /g, '-')}`);
            runGit(['init', '-q', '-b', 'main', dir]);
            configure(dir);
            const oid = store(dir);
            for (const name of ['.gitmodules', '.gitattributes']) {
              writeRawTree(dir, '100644', name, oid);
            }
            const git = gitFsck(dir);
            const sut = tsgitFsck;

            // Act
            const result = await sut(dir);

            // Assert
            expect(result.exitCode).toBe(git.exitCode);
            expect(reportLines(result.findings)).toEqual(gitReportLines(git.stderr));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );

  describe('Given a newer pack holding a .gitattributes tree then its blob, and an older pack a .gitmodules tree naming the same blob', () => {
    describe('When git fsck and tsgit fsck run', () => {
      it(
        'Then both check the blob in place, then again under both names',
        async () => {
          // Arrange
          const dir = path.join(root, 'special-both-names-split');
          runGit(['init', '-q', '-b', 'main', dir]);
          configure(dir);
          const blob = writeBlob(dir, `${EVIL_GITMODULES}${LONG_ATTRIBUTES_LINE}`);
          const attributesTree = writeRawTree(dir, '100644', '.gitattributes', blob);
          const modulesTree = writeRawTree(dir, '100644', '.gitmodules', blob);
          const newer = runGit(
            ['-C', dir, 'pack-objects', '-q', path.join(objectsOf(dir), 'pack', 'pack')],
            {
              input: `${attributesTree}\n${blob}\n`,
            },
          ).trim();
          const older = runGit(
            ['-C', dir, 'pack-objects', '-q', path.join(objectsOf(dir), 'pack', 'pack')],
            {
              input: `${modulesTree}\n`,
            },
          ).trim();
          runGit(['-C', dir, 'prune-packed']);
          for (const [name, seconds] of [
            [older, YEAR_2001_SECONDS],
            [newer, YEAR_2001_SECONDS + 86_400],
          ] as const) {
            for (const ext of ['pack', 'idx']) {
              utimesSync(
                path.join(objectsOf(dir), 'pack', `pack-${name}.${ext}`),
                seconds,
                seconds,
              );
            }
          }
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          expect(result.exitCode).toBe(git.exitCode);
          expect(reportLines(result.findings)).toEqual(gitReportLines(git.stderr));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe.each([
    { label: 'no promisor marker', marker: false, remote: [] as ReadonlyArray<string> },
    { label: 'a promisor pack but no promisor remote', marker: true, remote: [] },
    {
      label: 'a promisor pack and remote.origin.promisor',
      marker: true,
      remote: ['remote.origin.promisor', 'true'],
    },
    {
      label: 'a promisor pack and extensions.partialClone',
      marker: true,
      remote: ['extensions.partialClone', 'origin'],
    },
  ])(
    'Given a packed tree naming an absent .gitmodules blob, with $label',
    ({ label, marker, remote }) => {
      describe('When git fsck and tsgit fsck run', () => {
        it(
          'Then both report the blob alike',
          async () => {
            // Arrange
            const dir = path.join(root, `special-promisor-${label.replace(/\W+/g, '-')}`);
            runGit(['init', '-q', '-b', 'main', dir]);
            configure(dir);
            const blob = absentOid(dir, EVIL_GITMODULES);
            const tree = writeRawTree(dir, '100644', '.gitmodules', blob);
            const commit = runGit(['-C', dir, 'commit-tree', '-m', 'c', tree]).trim();
            runGit(['-C', dir, 'update-ref', 'refs/heads/main', commit]);
            const pack = runGit(
              ['-C', dir, 'pack-objects', '-q', path.join(objectsOf(dir), 'pack', 'pack')],
              {
                input: `${commit}\n${tree}\n`,
              },
            ).trim();
            runGit(['-C', dir, 'prune-packed']);
            if (marker)
              writeFileSync(path.join(objectsOf(dir), 'pack', `pack-${pack}.promisor`), '');
            if (remote.length > 0) {
              runGit(['-C', dir, 'config', 'remote.origin.url', 'file:///nonexistent']);
              runGit(['-C', dir, 'config', ...remote]);
            }
            const git = gitFsck(dir);
            const sut = tsgitFsck;

            // Act
            const result = await sut(dir);

            // Assert
            expect(result.exitCode).toBe(git.exitCode);
            expect(reportLines(result.findings)).toEqual(gitReportLines(git.stderr));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );

  describe('Given a promisor pack holding only a commit whose loose tree names an absent .gitmodules blob', () => {
    describe('When git fsck and tsgit fsck run', () => {
      it(
        'Then both report the blob yet walk nothing below the promisor commit',
        async () => {
          // Arrange
          const dir = path.join(root, 'special-promisor-loose-tree');
          runGit(['init', '-q', '-b', 'main', dir]);
          configure(dir);
          const blob = absentOid(dir, EVIL_GITMODULES);
          const tree = writeRawTree(dir, '100644', '.gitmodules', blob);
          const commit = runGit(['-C', dir, 'commit-tree', '-m', 'c', tree]).trim();
          runGit(['-C', dir, 'update-ref', 'refs/heads/main', commit]);
          const pack = runGit(
            ['-C', dir, 'pack-objects', '-q', path.join(objectsOf(dir), 'pack', 'pack')],
            { input: `${commit}\n` },
          ).trim();
          writeFileSync(path.join(objectsOf(dir), 'pack', `pack-${pack}.promisor`), '');
          runGit(['-C', dir, 'config', 'remote.origin.promisor', 'true']);
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          expect(result.exitCode).toBe(git.exitCode);
          expect(reportLines(result.findings)).toEqual(gitReportLines(git.stderr));
          expect(missingLines(result.findings)).toEqual(gitLines(git.stdout, MISSING_LINE));
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('fsck interop — promisor objects named by refs and reflogs', () => {
  describe.each([
    { label: 'no promisor remote', config: [] as ReadonlyArray<readonly [string, string]> },
    { label: 'remote.origin.promisor', config: [['remote.origin.promisor', 'true']] as const },
    {
      label: 'remote.origin.partialclonefilter',
      config: [['remote.origin.partialclonefilter', 'blob:none']] as const,
    },
  ])(
    'Given a promisor-pack commit whose absent parent a ref and a reflog name, with $label',
    ({ label, config }) => {
      describe('When git fsck and tsgit fsck run', () => {
        it(
          'Then both report the same pointers and missing objects',
          async () => {
            // Arrange
            const dir = path.join(root, `promisor-pointers-${label.replace(/\W+/g, '-')}`);
            runGit(['init', '-q', '-b', 'main', dir]);
            configure(dir);
            const tree = runGit(['-C', dir, 'mktree'], { input: '' }).trim();
            const parent = runGit(['-C', dir, 'commit-tree', '-m', 'parent', tree]).trim();
            const commit = runGit(['-C', dir, 'commit-tree', '-m', 'c', '-p', parent, tree]).trim();
            runGit(['-C', dir, 'update-ref', 'refs/heads/main', commit]);
            const pack = runGit(
              ['-C', dir, 'pack-objects', '-q', path.join(objectsOf(dir), 'pack', 'pack')],
              { input: `${commit}\n${tree}\n` },
            ).trim();
            runGit(['-C', dir, 'prune-packed']);
            rmSync(path.join(objectsOf(dir), parent.slice(0, 2), parent.slice(2)));
            writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'gone'), `${parent}\n`);
            writeFileSync(
              path.join(dir, '.git', 'logs', 'refs', 'heads', 'main'),
              `${parent} ${commit} Ada <ada@example.com> 1700000000 +0000\tx\n`,
            );
            writeFileSync(path.join(objectsOf(dir), 'pack', `pack-${pack}.promisor`), '');
            for (const [key, value] of config) runGit(['-C', dir, 'config', key, value]);
            const git = gitFsck(dir);
            const sut = tsgitFsck;

            // Act
            const result = await sut(dir);

            // Assert
            expect(result.exitCode).toBe(git.exitCode);
            expect(pointerLines(result.findings)).toEqual(gitLines(git.stderr, POINTER_LINE));
            expect(missingLines(result.findings)).toEqual(gitLines(git.stdout, MISSING_LINE));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});

describe.skipIf(!GIT_AVAILABLE)('fsck interop — symbolic refs that never resolve', () => {
  const writeRef = (dir: string, name: string, content: string): void =>
    writeFileSync(path.join(dir, '.git', 'refs', 'heads', name), `${content}\n`);

  describe.each([
    {
      label: 'a cycle',
      spoil: (dir: string) => {
        writeRef(dir, 'a', 'ref: refs/heads/b');
        writeRef(dir, 'b', 'ref: refs/heads/a');
      },
    },
    {
      label: 'a chain deeper than git follows',
      spoil: (dir: string) => {
        for (let hop = 1; hop <= 6; hop++) writeRef(dir, `c${hop}`, `ref: refs/heads/c${hop + 1}`);
        writeRef(dir, 'c7', runGit(['-C', dir, 'rev-parse', 'HEAD']).trim());
      },
    },
  ])('Given symbolic refs forming $label', ({ label, spoil }) => {
    describe('When git fsck and tsgit fsck run', () => {
      it(
        'Then both report the same zero-oid invalid pointers',
        async () => {
          // Arrange
          const dir = path.join(root, `symref-${label.replace(/\W+/g, '-')}`);
          runGit(['init', '-q', '-b', 'main', dir]);
          configure(dir);
          commitFile(dir, 'f', 'base');
          spoil(dir);
          const git = gitFsck(dir);
          const sut = tsgitFsck;

          // Act
          const result = await sut(dir);

          // Assert
          expect(result.exitCode).toBe(git.exitCode);
          expect(pointerLines(result.findings)).toEqual(gitLines(git.stderr, POINTER_LINE));
        },
        ROW_TIMEOUT,
      );
    });
  });
});
