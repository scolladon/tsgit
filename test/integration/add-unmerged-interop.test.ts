/**
 * Cross-tool interop — `add` and the unmerged paths it does not stage. Builds
 * the same real merge conflict in a peer and in ours, runs the same `add` on
 * both (`repo.add` against canonical `git add`), and asserts every stage of
 * the index (`git ls-files --stage`) agrees, so a conflict `add` leaves alone
 * survives it intact.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         add keeps every stage of the unmerged paths it does not stage
 *   interopSurface: add
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  gitAddVerbose,
  indexExtensionOf,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
  writeTreeOf,
} from './interop-helpers.js';

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

type Shape = 'both-modified' | 'deleted-by-them' | 'deleted-by-us' | 'added-by-both';

const SHAPES: ReadonlyArray<Shape> = ['both-modified', 'deleted-by-them', 'deleted-by-us'];
const RESOLVE_UNDO_SHAPES: ReadonlyArray<Shape> = [...SHAPES, 'added-by-both'];

const put = async (dir: string, file: string, content: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content);
};

const commitAll = (dir: string, message: string): void => {
  runGit(['-C', dir, 'add', '-A'], { env: COMMIT_ENV });
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: COMMIT_ENV });
};

const changeF = async (
  dir: string,
  shape: Shape,
  side: 'main' | 'side',
  conflicted: string,
): Promise<void> => {
  const removes =
    (shape === 'deleted-by-them' && side === 'side') ||
    (shape === 'deleted-by-us' && side === 'main');
  await put(dir, 'h', `h-${side}\n`);
  if (removes) runGit(['-C', dir, 'rm', '-q', conflicted]);
  else await put(dir, conflicted, `f-${side}\n`);
};

/** Leaves `f` and `h` unmerged (per `shape` for `f`) and `top`, `d/e` rewritten on disk. */
const buildConflict = async (dir: string, shape: Shape, conflicted = 'f'): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 'Ada']);
  runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
  const baseFiles =
    shape === 'added-by-both' ? ['h', 'top', 'd/e'] : [conflicted, 'h', 'top', 'd/e'];
  for (const file of baseFiles) await put(dir, file, `${file}-base\n`);
  commitAll(dir, 'base');
  runGit(['-C', dir, 'checkout', '-q', '-b', 'side']);
  await changeF(dir, shape, 'side', conflicted);
  commitAll(dir, 'side');
  runGit(['-C', dir, 'checkout', '-q', 'main']);
  await changeF(dir, shape, 'main', conflicted);
  commitAll(dir, 'main');
  const merged = tryRunGit(['-C', dir, '-c', 'merge.conflictStyle=merge', 'merge', 'side'], {
    env: COMMIT_ENV,
  });
  expect(merged.ok).toBe(false);
  await put(dir, 'top', 'top-new\n');
  await put(dir, 'd/e', 'e-new\n');
};

const REUC_SIGNATURE = Buffer.from('REUC');
const MODE_FIELD = Buffer.from('100644\0');

/** Rewrites the first mode of REUC to `9...` (not octal) and re-seals the index SHA-1 trailer. */
const corruptReuc = async (dir: string): Promise<void> => {
  const file = path.join(dir, '.git', 'index');
  const bytes = await readFile(file);
  const start = bytes.indexOf(REUC_SIGNATURE);
  const mode = bytes.indexOf(MODE_FIELD, start);
  bytes[mode] = 0x39;
  const body = bytes.subarray(0, bytes.length - 20);
  await writeFile(file, Buffer.concat([body, createHash('sha1').update(body).digest()]));
};

describe.skipIf(!GIT_AVAILABLE)(
  'add interop — unmerged paths add does not stage',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    const seedBoth = async (shape: Shape, conflicted = 'f'): Promise<void> => {
      pair = await makePeerPair('add-unmerged');
      await rm(pair.ours, { recursive: true, force: true });
      await rm(pair.peer, { recursive: true, force: true });
      await buildConflict(pair.peer, shape, conflicted);
      await buildConflict(pair.ours, shape, conflicted);
      repo = await openRepository({ cwd: pair.ours });
    };

    const seedZeroBesideConflictBoth = async (onDisk: string | undefined): Promise<void> => {
      await seedBoth('both-modified');
      for (const dir of [pair.ours, pair.peer]) {
        const idOf = (text: string): string =>
          runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: text }).trim();
        runGit(['-C', dir, 'update-index', '--index-info'], {
          input: [
            `100644 ${idOf('c-zero\n')} 0\tc`,
            `100644 ${idOf('c-ours\n')} 1\tc`,
            `100644 ${idOf('c-theirs\n')} 2\tc`,
            '',
          ].join('\n'),
        });
        if (onDisk !== undefined) await put(dir, 'c', onDisk);
      }
    };

    const agreesAfter = async (
      shape: Shape,
      specs: ReadonlyArray<string>,
      options: { readonly all?: boolean; readonly renormalize?: boolean } = {},
      before: (dir: string) => Promise<void> = async () => {},
    ): Promise<{ readonly ours: string; readonly peer: string }> => {
      await seedBoth(shape);
      await before(pair.ours);
      await before(pair.peer);
      await repo.add(specs, options);
      const gitArgs = [
        ...(options.all === true ? ['-A'] : []),
        ...(options.renormalize === true ? ['--renormalize'] : []),
        ...(specs.length > 0 ? ['--', ...specs] : []),
      ];
      runGit(['-C', pair.peer, 'add', ...gitArgs]);
      return { ours: lsStage(pair.ours), peer: lsStage(pair.peer) };
    };

    describe.each(SHAPES)('Given %s next to an unmerged h', (shape) => {
      describe.each([
        { title: 'top', specs: ['top'] },
        { title: 'f', specs: ['f'] },
        { title: 'top and f', specs: ['top', 'f'] },
        { title: 'the directory d', specs: ['d'] },
        { title: 'the glob t*', specs: ['t*'] },
      ])('When add stages $title', ({ specs }) => {
        it('Then every stage matches canonical git', async () => {
          // Arrange / Act
          const { ours, peer } = await agreesAfter(shape, specs);

          // Assert
          expect(ours).toBe(peer);
        });
      });
    });

    const gitReported = (dir: string, args: ReadonlyArray<string>): string[] => [
      ...gitAddVerbose(dir, args).added,
    ];

    describe.each(['deleted-by-them', 'deleted-by-us'] as const)(
      'Given %s with f equal to its last stage',
      (shape) => {
        describe.each([
          { title: 'add of f', specs: ['f'], options: {} },
          { title: 'add all', specs: [] as string[], options: { all: true } },
        ])('When $title runs', ({ specs, options }) => {
          it('Then modified is what canonical git reports', async () => {
            // Arrange
            await seedBoth(shape);
            const gitArgs = [...(options.all === true ? ['-A'] : []), ...specs];

            // Act
            const result = await repo.add(specs, options);

            // Assert
            const reported = gitReported(pair.peer, gitArgs);
            expect(result.added).toEqual([]);
            expect([...result.modified].sort()).toEqual(reported);
            expect(result.modified).toContain('f');
          });
        });
      },
    );

    describe('Given a deleted f next to an unmerged h', () => {
      describe('When add stages top', () => {
        it('Then every stage matches canonical git', async () => {
          // Arrange / Act
          const { ours, peer } = await agreesAfter('both-modified', ['top'], {}, (dir) =>
            rm(path.join(dir, 'f')),
          );

          // Assert
          expect(ours).toBe(peer);
        });
      });
    });

    describe('Given an unmerged f and h next to rewritten tracked paths', () => {
      describe.each([
        { title: 'add all', specs: [] as string[], options: { all: true } },
        { title: 'add of the whole tree', specs: ['.'], options: {} },
        { title: 'add renormalize', specs: ['.'], options: { renormalize: true } },
      ])('When $title runs', ({ specs, options }) => {
        it('Then the index matches canonical git', async () => {
          // Arrange / Act
          const { ours, peer } = await agreesAfter('both-modified', specs, options);

          // Assert
          expect(ours).toBe(peer);
          if (options.renormalize === true) return;
          expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
        });
      });
    });

    describe('Given an unmerged f deleted from the working tree', () => {
      describe('When add all runs', () => {
        it('Then every stage of f is gone as in canonical git', async () => {
          // Arrange / Act
          const { ours, peer } = await agreesAfter('both-modified', [], { all: true }, (dir) =>
            rm(path.join(dir, 'f')),
          );

          // Assert
          expect(ours).toBe(peer);
          expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
        });
      });
    });

    const resolveUndoListing = (dir: string): string =>
      runGit(['-C', dir, 'ls-files', '--resolve-undo']);

    const expectSameResolveUndo = async (): Promise<void> => {
      expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
      expect(await indexExtensionOf(pair.ours, 'REUC')).toEqual(
        await indexExtensionOf(pair.peer, 'REUC'),
      );
      expect(resolveUndoListing(pair.ours)).toBe(resolveUndoListing(pair.peer));
    };

    describe.each(RESOLVE_UNDO_SHAPES)('Given %s next to an unmerged h', (shape) => {
      describe.each([
        { title: 'f', specs: ['f'] },
        { title: 'f and h', specs: ['f', 'h'] },
        { title: 'the whole tree', specs: ['.'] },
        { title: 'top only', specs: ['top'] },
      ])('When add stages $title', ({ specs }) => {
        it('Then REUC and the resolve-undo listing match canonical git', async () => {
          // Arrange / Act
          await agreesAfter(shape, specs);

          // Assert
          await expectSameResolveUndo();
        });
      });
    });

    describe('Given an unmerged f deleted from the working tree', () => {
      describe('When add all runs', () => {
        it('Then REUC matches canonical git', async () => {
          // Arrange / Act
          await agreesAfter('both-modified', [], { all: true }, (dir) => rm(path.join(dir, 'f')));

          // Assert
          await expectSameResolveUndo();
        });
      });
    });

    describe('Given f resolved by add', () => {
      describe('When add f, the whole tree, add all and a commit follow', () => {
        it('Then the resolve-undo records stay equal to canonical git after each', async () => {
          // Arrange
          await agreesAfter('both-modified', ['f']);
          const runBoth = async (
            specs: ReadonlyArray<string>,
            options: { readonly all?: boolean } = {},
          ): Promise<void> => {
            await repo.add([...specs], options);
            runGit(['-C', pair.peer, 'add', ...(options.all === true ? ['-A'] : ['--', ...specs])]);
            await expectSameResolveUndo();
          };

          // Act / Assert
          await runBoth(['f']);
          await runBoth(['top']);
          await runBoth(['.']);
          await runBoth([], { all: true });
          await runBoth(['h']);
          await repo.commit({ message: 'merge', author: AUTHOR, committer: AUTHOR });
          runGit(['-C', pair.peer, 'commit', '-q', '-m', 'merge'], { env: COMMIT_ENV });
          await expectSameResolveUndo();
        });
      });
    });

    describe('Given a resolve-undo record for h written by canonical git and an unmerged f', () => {
      describe('When add stages f', () => {
        it('Then REUC holds both records as in canonical git', async () => {
          // Arrange
          await seedBoth('both-modified');
          for (const dir of [pair.ours, pair.peer]) {
            runGit(['-C', dir, 'rm', '--cached', '-q', 'h']);
          }
          await repo.dispose();
          repo = await openRepository({ cwd: pair.ours });

          // Act
          await repo.add(['f']);
          runGit(['-C', pair.peer, 'add', '--', 'f']);

          // Assert
          await expectSameResolveUndo();
        });
      });
    });

    describe('Given f re-created at stages 1 and 2 after its resolution', () => {
      describe('When add stages f', () => {
        it('Then the stale stage 3 stays as in canonical git', async () => {
          // Arrange
          await seedBoth('both-modified');
          await repo.add(['f']);
          runGit(['-C', pair.peer, 'add', '--', 'f']);
          for (const dir of [pair.ours, pair.peer]) {
            const info = [
              `100644 ${runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'n1\n' }).trim()} 1\tf`,
              `100755 ${runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'n2\n' }).trim()} 2\tf`,
            ].join('\n');
            runGit(['-C', dir, 'update-index', '--force-remove', 'f']);
            runGit(['-C', dir, 'update-index', '--index-info'], { input: `${info}\n` });
          }

          // Act
          await repo.add(['f']);
          runGit(['-C', pair.peer, 'add', '--', 'f']);

          // Assert
          await expectSameResolveUndo();
        });
      });
    });

    describe('Given a corrupt REUC and an unmerged h', () => {
      describe('When add stages h', () => {
        it('Then the result matches canonical git', async () => {
          // Arrange
          await seedBoth('both-modified');
          await repo.add(['f']);
          runGit(['-C', pair.peer, 'add', '--', 'f']);
          for (const dir of [pair.ours, pair.peer]) await corruptReuc(dir);

          // Act
          await repo.add(['h']);
          runGit(['-C', pair.peer, 'add', '--', 'h']);

          // Assert
          await expectSameResolveUndo();
        });
      });
    });

    describe('Given two unmerged paths named in one add', () => {
      describe('When add stages f and h', () => {
        it('Then REUC and TREE match canonical git', async () => {
          // Arrange / Act
          await agreesAfter('both-modified', ['f', 'h']);

          // Assert
          await expectSameResolveUndo();
          expect(await indexExtensionOf(pair.ours, 'TREE')).toEqual(
            await indexExtensionOf(pair.peer, 'TREE'),
          );
        });
      });
    });

    interface ExclusionRow {
      readonly title: string;
      readonly conflicted: string;
      readonly shape: Shape;
      readonly ours: ReadonlyArray<string>;
      readonly git: ReadonlyArray<string>;
    }

    const LEAKS: ReadonlyArray<ExclusionRow> = [
      {
        title: 'D0',
        conflicted: 'f',
        shape: 'both-modified',
        ours: ['.', '!f'],
        git: ['.', ':!f'],
      },
      {
        title: 'D1',
        conflicted: 'f',
        shape: 'deleted-by-them',
        ours: ['.', '!f'],
        git: ['.', ':!f'],
      },
      {
        title: 'D4',
        conflicted: 'd/f',
        shape: 'both-modified',
        ours: ['d', '!d/f'],
        git: ['d', ':!d/f'],
      },
      {
        title: 'D7',
        conflicted: 'f.txt',
        shape: 'both-modified',
        ours: ['*.txt', '!f.txt'],
        git: ['*.txt', ':!f.txt'],
      },
      {
        title: 'D8',
        conflicted: 'f',
        shape: 'both-modified',
        ours: ['f*', '!f'],
        git: ['f*', ':!f'],
      },
      {
        title: 'E1',
        conflicted: 'f',
        shape: 'both-modified',
        ours: ['f', '.', '!f'],
        git: ['f', '.', ':!f'],
      },
      {
        title: 'D16',
        conflicted: 'f',
        shape: 'both-modified',
        ours: ['.', '!f'],
        git: ['.', ':(exclude)f'],
      },
      {
        title: 'E8',
        conflicted: 'f',
        shape: 'both-modified',
        ours: ['.', '!f'],
        git: ['.', ':!./f'],
      },
      {
        title: 'E10',
        conflicted: 'f.txt',
        shape: 'both-modified',
        ours: ['.', '!f.txt'],
        git: ['.', ':(exclude,literal)f.txt'],
      },
    ];

    const SHIELDS: ReadonlyArray<ExclusionRow> = [
      {
        title: 'D5',
        conflicted: 'd/f',
        shape: 'both-modified',
        ours: ['.', '!d'],
        git: ['.', ':!d'],
      },
      {
        title: 'D6',
        conflicted: 'f.txt',
        shape: 'both-modified',
        ours: ['.', '!*.txt'],
        git: ['.', ':!*.txt'],
      },
      {
        title: 'E3',
        conflicted: 'f',
        shape: 'both-modified',
        ours: ['.', '!f*'],
        git: ['.', ':!f*'],
      },
      {
        title: 'E3 on a path literally named f*',
        conflicted: 'f*',
        shape: 'both-modified',
        ours: ['.', '!f*'],
        git: ['.', ':!f*'],
      },
      {
        title: 'E4',
        conflicted: 'd/f',
        shape: 'both-modified',
        ours: ['.', '!d/'],
        git: ['.', ':!d/'],
      },
      {
        title: 'E7',
        conflicted: 'f',
        shape: 'both-modified',
        ours: ['.', '!f', '!f*'],
        git: ['.', ':!f', ':!f*'],
      },
    ];

    describe.each(LEAKS)('Given $title an exact exclusion of a conflicted path', (row) => {
      describe('When add walks a pathspec another element covers', () => {
        it('Then the path, its report and REUC match canonical git', async () => {
          // Arrange
          await seedBoth(row.shape, row.conflicted);

          // Act
          const result = await repo.add([...row.ours]);

          // Assert
          const reported = gitReported(pair.peer, row.git);
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          expect([...result.modified, ...result.added].sort()).toEqual(reported);
          expect(result.modified).toContain(row.conflicted);
          await expectSameResolveUndo();
        });
      });
    });

    describe.each(SHIELDS)(
      'Given $title an exclusion that still shields a conflicted path',
      (row) => {
        describe('When add walks the whole tree', () => {
          it('Then every stage is kept and no REUC is written as in canonical git', async () => {
            // Arrange
            await seedBoth(row.shape, row.conflicted);

            // Act
            await repo.add([...row.ours]);
            runGit(['-C', pair.peer, 'add', '--', ...row.git]);

            // Assert
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            await expectSameResolveUndo();
          });
        });
      },
    );

    describe('Given S1 a conflicted f held at stage 3 only', () => {
      describe('When add walks the whole tree excluding f', () => {
        it('Then stage 3 is kept as in canonical git', async () => {
          // Arrange
          await seedBoth('both-modified');
          for (const dir of [pair.ours, pair.peer]) {
            const id = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
              input: 's1\n',
            }).trim();
            runGit(['-C', dir, 'update-index', '--force-remove', 'f']);
            runGit(['-C', dir, 'update-index', '--index-info'], {
              input: `100644 ${id} 3\tf\n`,
            });
          }

          // Act
          await repo.add(['.', '!f']);
          runGit(['-C', pair.peer, 'add', '--', '.', ':!f']);

          // Assert
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          await expectSameResolveUndo();
        });
      });
    });

    describe.each([
      { title: 'unchanged', onDisk: 'c-zero\n' },
      { title: 'modified', onDisk: 'c-new\n' },
    ])('Given c held at stage 0 and at the conflict stages 1 and 2, $title on disk', (row) => {
      describe('When add top runs', () => {
        it('Then the report, the stages and the resolve-undo listing match canonical git', async () => {
          // Arrange
          await seedZeroBesideConflictBoth(row.onDisk);

          // Act
          const result = await repo.add(['top']);
          const reported = gitAddVerbose(pair.peer, ['top']);

          // Assert
          expect([...result.added, ...result.modified].sort()).toEqual(reported.added);
          expect(result.modified).toEqual(['top']);
          await expectSameResolveUndo();
        });
      });
    });

    describe('Given c held at stage 0 and at the conflict stages 1 and 2, modified on disk', () => {
      describe('When add c runs', () => {
        it('Then the stages, the resolve-undo listing and the report match canonical git', async () => {
          // Arrange
          await seedZeroBesideConflictBoth('c-new\n');

          // Act
          const result = await repo.add(['c']);
          const reported = gitAddVerbose(pair.peer, ['c']);

          // Assert
          expect([...new Set(reported.removed)]).toEqual(result.removed);
          expect([...result.added, ...result.modified].sort()).toEqual(reported.added);
          await expectSameResolveUndo();
        });
      });
    });

    describe.each([
      { title: 'add c', ours: ['c'], git: ['c'] },
      { title: 'add .', ours: ['.'], options: undefined, git: ['.'] },
      { title: 'add all', ours: [], options: { all: true }, git: ['-A'] },
    ])('Given c held at stage 0 and at the conflict stages 1 and 2, unchanged on disk', (row) => {
      describe(`When ${row.title} runs`, () => {
        it('Then the stages, the resolve-undo listing and the report match canonical git', async () => {
          // Arrange
          await seedZeroBesideConflictBoth('c-zero\n');

          // Act
          const result = await repo.add([...row.ours], row.options);
          const reported = gitAddVerbose(pair.peer, row.git);

          // Assert
          expect([...new Set(reported.removed)]).toEqual(result.removed);
          expect([...result.added, ...result.modified].sort()).toEqual(reported.added);
          await expectSameResolveUndo();
        });
      });
    });

    describe.each([
      { title: 'modified', onDisk: 'c-new\n' },
      { title: 'deleted', onDisk: undefined },
    ])('Given c held at stage 0 and at the conflict stages 1 and 2, $title on disk', (row) => {
      describe('When add all runs', () => {
        it('Then the stages, the resolve-undo listing and the report match canonical git', async () => {
          // Arrange
          await seedZeroBesideConflictBoth(row.onDisk);

          // Act
          const result = await repo.add([], { all: true });
          const reported = gitAddVerbose(pair.peer, ['-A']);

          // Assert
          expect([...new Set(reported.removed)]).toEqual(result.removed);
          expect([...result.added, ...result.modified].sort()).toEqual(reported.added);
          await expectSameResolveUndo();
        });
      });
    });
  },
);
