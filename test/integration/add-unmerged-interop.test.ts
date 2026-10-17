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
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
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

type Shape = 'both-modified' | 'deleted-by-them' | 'deleted-by-us';

const SHAPES: ReadonlyArray<Shape> = ['both-modified', 'deleted-by-them', 'deleted-by-us'];

const put = async (dir: string, file: string, content: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content);
};

const commitAll = (dir: string, message: string): void => {
  runGit(['-C', dir, 'add', '-A'], { env: COMMIT_ENV });
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: COMMIT_ENV });
};

const changeF = async (dir: string, shape: Shape, side: 'main' | 'side'): Promise<void> => {
  const removes =
    (shape === 'deleted-by-them' && side === 'side') ||
    (shape === 'deleted-by-us' && side === 'main');
  await put(dir, 'h', `h-${side}\n`);
  if (removes) runGit(['-C', dir, 'rm', '-q', 'f']);
  else await put(dir, 'f', `f-${side}\n`);
};

/** Leaves `f` and `h` unmerged (per `shape` for `f`) and `top`, `d/e` rewritten on disk. */
const buildConflict = async (dir: string, shape: Shape): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 'Ada']);
  runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
  for (const file of ['f', 'h', 'top', 'd/e']) await put(dir, file, `${file}-base\n`);
  commitAll(dir, 'base');
  runGit(['-C', dir, 'checkout', '-q', '-b', 'side']);
  await changeF(dir, shape, 'side');
  commitAll(dir, 'side');
  runGit(['-C', dir, 'checkout', '-q', 'main']);
  await changeF(dir, shape, 'main');
  commitAll(dir, 'main');
  const merged = tryRunGit(['-C', dir, '-c', 'merge.conflictStyle=merge', 'merge', 'side'], {
    env: COMMIT_ENV,
  });
  expect(merged.ok).toBe(false);
  await put(dir, 'top', 'top-new\n');
  await put(dir, 'd/e', 'e-new\n');
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

    const seedBoth = async (shape: Shape): Promise<void> => {
      pair = await makePeerPair('add-unmerged');
      await rm(pair.ours, { recursive: true, force: true });
      await rm(pair.peer, { recursive: true, force: true });
      await buildConflict(pair.peer, shape);
      await buildConflict(pair.ours, shape);
      repo = await openRepository({ cwd: pair.ours });
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

    const ADD_LINE = /^add '(.*)'$/;

    const gitReported = (dir: string, args: ReadonlyArray<string>): string[] =>
      runGit(['-C', dir, 'add', '-v', ...args])
        .split('\n')
        .flatMap((line) => ADD_LINE.exec(line)?.[1] ?? [])
        .sort();

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
  },
);
