/**
 * Cross-tool interop — a checkout never writes through a leading symlink.
 * The same tree is built with git plumbing in a canonical-git peer and a tsgit
 * repo; both tools then rewrite the work tree and the resulting directories,
 * the outside directory the link pointed at, and `git status` are compared.
 * The fold rows need a case-insensitive filesystem and are skipped elsewhere.
 *
 * @proves
 *   surface:        repo.checkout
 *   bucket:         cross-tool-interop
 *   unique:         checkout leading-symlink safety runs against git
 *   interopSurface: checkout
 */
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const SYMLINK_MODE = '120000';
const REGULAR_MODE = '100644';
const PAYLOAD = 'payload\n';

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

interface TreeEntry {
  readonly mode: string;
  readonly content: string;
  readonly path: string;
}

const isCaseInsensitiveFilesystem = async (): Promise<boolean> => {
  const probeDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fold-probe-'));
  try {
    await writeFile(path.join(probeDir, 'Probe-File'), '');
    return existsSync(path.join(probeDir, 'probe-file'));
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
};

const CASE_INSENSITIVE = await isCaseInsensitiveFilesystem();

const commitTree = (dir: string, entries: ReadonlyArray<TreeEntry>): void => {
  runGit(['-C', dir, 'init', '-q', '-b', 'main']);
  for (const entry of entries) {
    const oid = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
      input: entry.content,
    }).trim();
    runGit([
      '-C',
      dir,
      'update-index',
      '--add',
      '--cacheinfo',
      `${entry.mode},${oid},${entry.path}`,
    ]);
  }
  const tree = runGit(['-C', dir, 'write-tree']).trim();
  const commit = runGit(['-C', dir, 'commit-tree', tree, '-m', 'seed'], { env: COMMIT_ENV }).trim();
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', commit]);
};

const commitOn = (
  dir: string,
  entries: ReadonlyArray<TreeEntry>,
  parent: string | undefined,
  message: string,
): string => {
  runGit(['-C', dir, 'read-tree', '--empty']);
  for (const entry of entries) {
    const oid = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
      input: entry.content,
    }).trim();
    runGit([
      '-C',
      dir,
      'update-index',
      '--add',
      '--cacheinfo',
      `${entry.mode},${oid},${entry.path}`,
    ]);
  }
  const tree = runGit(['-C', dir, 'write-tree']).trim();
  const parents = parent === undefined ? [] : ['-p', parent];
  return runGit(['-C', dir, 'commit-tree', tree, ...parents, '-m', message], {
    env: COMMIT_ENV,
  }).trim();
};

const seedConflictedMerge = (dir: string, outside: string): void => {
  runGit(['-C', dir, 'init', '-q', '-b', 'main']);
  const text = (content: string): TreeEntry => ({
    mode: REGULAR_MODE,
    content,
    path: 'file.txt',
  });
  const base = commitOn(dir, [text('a\nb\nc\n')], undefined, 'base');
  const theirs = commitOn(
    dir,
    [
      text('a\nY\nc\n'),
      { mode: SYMLINK_MODE, content: outside, path: 'A' },
      { mode: REGULAR_MODE, content: PAYLOAD, path: 'a/payload' },
    ],
    base,
    'theirs',
  );
  const ours = commitOn(dir, [text('a\nX\nc\n')], base, 'ours');
  runGit(['-C', dir, 'update-ref', 'refs/heads/theirs', theirs]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', ours]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.parentPath.includes(`${path.sep}.git`) && entry.name !== '.git')
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();

describe.skipIf(!GIT_AVAILABLE)(
  'checkout interop — leading symlink safety',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;
    let outsides: { readonly peer: string; readonly ours: string };

    const link = (outside: string): TreeEntry => ({
      mode: SYMLINK_MODE,
      content: outside,
      path: 'A',
    });
    const payload = (entryPath: string): TreeEntry => ({
      mode: REGULAR_MODE,
      content: PAYLOAD,
      path: entryPath,
    });

    beforeEach(async () => {
      pair = await makePeerPair('checkout-leading-symlink');
      outsides = {
        peer: await mkdtemp(path.join(os.tmpdir(), 'tsgit-outside-peer-')),
        ours: await mkdtemp(path.join(os.tmpdir(), 'tsgit-outside-ours-')),
      };
      repo = undefined;
    });

    afterEach(async () => {
      await repo?.dispose();
      await pair.dispose();
      await rm(outsides.peer, { recursive: true, force: true });
      await rm(outsides.ours, { recursive: true, force: true });
    });

    describe('Given a worktree symlink a to an outside directory, an empty index and a tree holding only a/payload (guard: shared behaviour, not the case-fold race)', () => {
      describe('When both tools force-checkout HEAD', () => {
        it('Then a is a real directory holding payload and the outside directory stays empty, matching git', async () => {
          // Arrange
          const sides = [
            { dir: pair.peer, outside: outsides.peer },
            { dir: pair.ours, outside: outsides.ours },
          ];
          for (const { dir, outside } of sides) {
            commitTree(dir, [payload('a/payload')]);
            runGit(['-C', dir, 'read-tree', '--empty']);
            symlinkSync(outside, path.join(dir, 'a'));
          }
          repo = await openRepository({ cwd: pair.ours });

          // Act
          runGit(['-C', pair.peer, 'checkout', '-q', '-f', 'HEAD']);
          await repo.checkout({ rev: 'HEAD', force: true });

          // Assert
          for (const { dir, outside } of sides) {
            expect(lstatSync(path.join(dir, 'a')).isDirectory()).toBe(true);
            expect(readFileSync(path.join(dir, 'a', 'payload'), 'utf8')).toBe(PAYLOAD);
            expect(readdirSync(outside)).toEqual([]);
          }
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
        });
      });
    });

    describe('Given a worktree symlink a to an outside directory, a populated index and a tree holding only a/payload', () => {
      describe('When both tools force-checkout HEAD', () => {
        it('Then a is a real directory holding payload and the outside directory stays empty, matching git', async () => {
          // Arrange
          const sides = [
            { dir: pair.peer, outside: outsides.peer },
            { dir: pair.ours, outside: outsides.ours },
          ];
          for (const { dir, outside } of sides) {
            commitTree(dir, [payload('a/payload')]);
            symlinkSync(outside, path.join(dir, 'a'));
          }
          repo = await openRepository({ cwd: pair.ours });

          // Act
          runGit(['-C', pair.peer, 'checkout', '-q', '-f', 'HEAD']);
          await repo.checkout({ rev: 'HEAD', force: true });

          // Assert
          for (const { dir, outside } of sides) {
            expect(lstatSync(path.join(dir, 'a')).isDirectory()).toBe(true);
            expect(readFileSync(path.join(dir, 'a', 'payload'), 'utf8')).toBe(PAYLOAD);
            expect(readdirSync(outside)).toEqual([]);
          }
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
        });
      });
    });

    const movedBehindLink = (): ReadonlyArray<{
      readonly dir: string;
      readonly outside: string;
    }> => {
      const sides = [
        { dir: pair.peer, outside: outsides.peer },
        { dir: pair.ours, outside: outsides.ours },
      ];
      for (const { dir, outside } of sides) {
        commitTree(dir, [payload('a/payload')]);
        runGit(['-C', dir, 'reset', '-q', '--hard', 'HEAD']);
        renameSync(path.join(dir, 'a'), path.join(outside, 'a'));
        symlinkSync(path.join(outside, 'a'), path.join(dir, 'a'));
      }
      return sides;
    };

    describe.each([
      ['checkout -- .', ['checkout', '-q', '--', '.'], { paths: ['.'] }],
      [
        'checkout HEAD -- .',
        ['checkout', '-q', 'HEAD', '--', '.'],
        { paths: ['.'], source: 'HEAD' },
      ],
    ] as const)(
      'Given a tracked a/payload whose directory a moved outside and left a link, with the command %s',
      (_name, gitArgs, tsgit) => {
        describe('When both tools run it', () => {
          it('Then a is a real directory holding payload, as git rewrites an entry beyond a link', async () => {
            // Arrange
            const sides = movedBehindLink();
            repo = await openRepository({ cwd: pair.ours });

            // Act
            runGit(['-C', pair.peer, ...gitArgs]);
            await repo.checkout(tsgit);

            // Assert
            for (const { dir } of sides) {
              expect(lstatSync(path.join(dir, 'a')).isDirectory()).toBe(true);
              expect(readFileSync(path.join(dir, 'a', 'payload'), 'utf8')).toBe(PAYLOAD);
            }
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
          });
        });
      },
    );

    describe.each([
      ['checkout -f HEAD', ['checkout', '-q', '-f', 'HEAD']],
      ['reset --hard HEAD', ['reset', '-q', '--hard', 'HEAD']],
    ] as const)(
      'Given a tracked a/payload whose directory a moved outside and left a link, with the command %s (guard: the one-way merge keeps an up-to-date link)',
      (name, gitArgs) => {
        describe('When both tools run it', () => {
          it('Then a stays a link to the moved directory in both', async () => {
            // Arrange
            const sides = movedBehindLink();
            repo = await openRepository({ cwd: pair.ours });

            // Act
            runGit(['-C', pair.peer, ...gitArgs]);
            await (name === 'reset --hard HEAD'
              ? repo.reset({ mode: 'hard', rev: 'HEAD' })
              : repo.checkout({ rev: 'HEAD', force: true }));

            // Assert
            for (const { dir } of sides) {
              expect(lstatSync(path.join(dir, 'a')).isSymbolicLink()).toBe(true);
            }
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
          });
        });
      },
    );

    describe.skipIf(!CASE_INSENSITIVE)(
      'Given a tree holding a symlink A to an outside directory and a/payload, on a case-insensitive filesystem',
      () => {
        describe('When both tools hard-reset an empty work tree to HEAD', () => {
          it('Then a is a real directory holding payload, the outside directory is empty and status matches git', async () => {
            // Arrange
            const sides = [
              { dir: pair.peer, outside: outsides.peer },
              { dir: pair.ours, outside: outsides.ours },
            ];
            for (const { dir, outside } of sides) {
              commitTree(dir, [link(outside), payload('a/payload')]);
            }
            repo = await openRepository({ cwd: pair.ours });

            // Act
            runGit(['-C', pair.peer, 'reset', '-q', '--hard', 'HEAD']);
            await repo.reset({ mode: 'hard', rev: 'HEAD' });

            // Assert
            for (const { dir, outside } of sides) {
              expect(lstatSync(path.join(dir, 'a')).isDirectory()).toBe(true);
              expect(readFileSync(path.join(dir, 'a', 'payload'), 'utf8')).toBe(PAYLOAD);
              expect(readdirSync(outside)).toEqual([]);
            }
            const status = (dir: string): string => runGit(['-C', dir, 'status', '--porcelain']);
            expect(status(pair.ours)).toBe(status(pair.peer));
          });
        });

        describe('When both tools hard-reset a tree holding a and A/payload', () => {
          it('Then the outside directory is empty on both tools', async () => {
            // Arrange
            const sides = [
              { dir: pair.peer, outside: outsides.peer },
              { dir: pair.ours, outside: outsides.ours },
            ];
            for (const { dir, outside } of sides) {
              commitTree(dir, [
                { mode: SYMLINK_MODE, content: outside, path: 'a' },
                payload('A/payload'),
              ]);
            }
            repo = await openRepository({ cwd: pair.ours });

            // Act
            runGit(['-C', pair.peer, 'reset', '-q', '--hard', 'HEAD']);
            await repo.reset({ mode: 'hard', rev: 'HEAD' });

            // Assert
            for (const { outside } of sides) expect(readdirSync(outside)).toEqual([]);
          });
        });
        describe('When both tools run a conflicted merge whose theirs adds A and a/payload', () => {
          it('Then the outside directory is empty on both tools', async () => {
            // Arrange
            const sides = [
              { dir: pair.peer, outside: outsides.peer },
              { dir: pair.ours, outside: outsides.ours },
            ];
            for (const { dir, outside } of sides) seedConflictedMerge(dir, outside);
            repo = await openRepository({ cwd: pair.ours });

            // Act
            expect(() =>
              runGit(['-C', pair.peer, 'merge', '-q', 'theirs'], { env: COMMIT_ENV }),
            ).toThrow();
            const result = await repo.merge.run({ rev: 'theirs' });

            // Assert
            expect(result.kind).toBe('conflict');
            for (const { outside } of sides) expect(readdirSync(outside)).toEqual([]);
          });
        });
      },
    );
  },
);
