/**
 * Which commits a cherry-pick / revert of ranges, or a rebase, replays, and in what order:
 * git seeds ONE limited walk from every argument (`limit_list`, commit-date
 * order with its SLOP give-up), so clock-skewed excluded lines and
 * equal-date branches decide the result. Each row runs git on one copy of a
 * dated history and tsgit on another, then compares the replayed subjects.
 *
 * @proves
 *   surface:        cherryPick, revert, rebase
 *   bucket:         cross-tool-interop
 *   unique:         ranges and plain commits seed one date-ordered limited walk, so skewed exclusions, duplicates and equal-date ties pick git's commits in git's order
 */
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const EPOCH = 1_700_000_000;

/** `[name, committer-date offset, parent names]`, parents declared first. */
const HISTORY: ReadonlyArray<readonly [string, number, ReadonlyArray<string>]> = [
  ['z', 50, []],
  ['x', 500, []],
  ['i', 1000, ['x']],
  ['skew1', 299, ['x']],
  ['skew2', 298, ['skew1']],
  ['skew3', 297, ['skew2']],
  ['skew4', 296, ['skew3']],
  ['skew5', 295, ['skew4']],
  ['skew6', 294, ['skew5']],
  ['near', 400, ['skew3']],
  ['far', 400, ['skew6']],
  ['root', 100, []],
  ['left1', 200, ['root']],
  ['left2', 400, ['left1']],
  ['right1', 300, ['root']],
  ['right2', 150, ['right1']],
  ['tie1', 300, ['root']],
  ['tie2', 300, ['root']],
  ['tie3', 300, ['tie1']],
  ['merge', 600, ['left2', 'right2']],
  ['merge3', 700, ['tie3', 'tie2']],
  ['up', 900, ['root']],
  ['feat1', 200, ['root']],
  ['side1', 300, ['root']],
  ['side2', 350, ['side1']],
  ['feat-merge', 400, ['feat1', 'side2']],
  ['feat2', 500, ['feat-merge']],
  ['skewed1', 600, ['root']],
  ['skewed2', 250, ['skewed1']],
  ['skewed3', 700, ['skewed2']],
  ['tie-merge', 300, ['tie1', 'tie2']],
  ['tie4', 300, ['tie-merge']],
  ['yonder', 500, []],
  ['slop1', 299, ['yonder']],
  ['slop2', 298, ['slop1']],
  ['slop3', 297, ['slop2']],
  ['slop4', 296, ['slop3']],
  ['slop5', 295, ['slop4']],
  ['slop6', 294, ['slop5']],
  ['bottom', 400, ['slop6']],
  ['upper', 450, ['bottom']],
  ['head-merge', 1000, ['bottom', 'yonder']],
  ['head-tip', 1100, ['head-merge']],
];

let root: string;
let fixture: string;
let count = 0;

/** Each commit carries one file per ancestor, so every pick and revert has a change. */
const buildHistory = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  const files = new Map<string, ReadonlySet<string>>();
  const ids = new Map<string, string>();
  for (const [name, offset, parents] of HISTORY) {
    const own = new Set([name, ...parents.flatMap((parent) => [...(files.get(parent) ?? [])])]);
    files.set(name, own);
    const tree = runGit(['-C', dir, 'mktree'], {
      input: [...own]
        .sort()
        .map((file) => `100644 blob ${blobOf(dir, file)}\t${file}\n`)
        .join(''),
    }).trim();
    const date = `${EPOCH + offset} +0000`;
    const parentArgs = parents.flatMap((parent) => ['-p', ids.get(parent) as string]);
    const id = runGit(['-C', dir, 'commit-tree', tree, '-m', name, ...parentArgs], {
      env: { ...runGitEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    }).trim();
    ids.set(name, id);
    git(dir, 'update-ref', `refs/heads/${name}`, id);
  }
};

const blobOf = (dir: string, file: string): string =>
  runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: `${file}\n` }).trim();

const copyAt = (base: string): string => {
  count += 1;
  const dir = path.join(root, `copy-${count}`);
  cpSync(fixture, dir, { recursive: true });
  git(dir, 'checkout', '-q', '-f', '-B', 'work', base);
  return dir;
};

const replayed = (dir: string, base: string): ReadonlyArray<string> =>
  git(dir, 'log', '--format=%s', '--reverse', `${base}..HEAD`).split('\n').filter(Boolean);

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-seq-range-')));
  fixture = path.join(root, 'fixture');
  if (GIT_AVAILABLE) buildHistory(fixture);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)('interop — cherry-pick range order', () => {
  describe.each([
    { args: ['far..i'], expected: ['x', 'i'] },
    { args: ['near..i'], expected: ['i'] },
    { args: ['root..left2', 'root..right2'], expected: ['right1', 'right2', 'left1', 'left2'] },
    { args: ['root..right2', 'root..left2'], expected: ['right1', 'right2', 'left1', 'left2'] },
    { args: ['right2', 'root..left2'], expected: ['right1', 'right2', 'left1', 'left2'] },
    { args: ['root..tie3', 'root..tie2'], expected: ['tie1', 'tie2', 'tie3'] },
    { args: ['root..tie2', 'root..tie3'], expected: ['tie1', 'tie3', 'tie2'] },
    { args: ['root..left2', 'left1..left2'], expected: ['left2'] },
    { args: ['left2', 'right1', 'right1'], expected: ['left2', 'right1'] },
    { args: ['left2^'], expected: ['left1'] },
    { args: ['^root', 'left2'], expected: ['left1', 'left2'] },
    { args: ['left2', '^left1'], expected: ['left2'] },
  ])('Given the arguments $args', ({ args, expected }) => {
    describe('When git and tsgit cherry-pick them onto z', () => {
      it(
        'Then both replay the commits git pins, in its order',
        async () => {
          // Arrange
          const gitDir = copyAt('z');
          tryRunGitWithExit(['-C', gitDir, 'cherry-pick', ...args]);
          const tsgitDir = copyAt('z');
          const repo = await openRepository({ cwd: tsgitDir });
          const sut = repo.cherryPick;

          // Act
          try {
            await sut.run({ commits: args });
          } finally {
            await repo.dispose();
          }

          // Assert
          expect(replayed(gitDir, 'z')).toEqual(expected);
          expect(replayed(tsgitDir, 'z')).toEqual(expected);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('interop — revert range order', () => {
  describe.each([
    { base: 'i', args: ['far..i'], expected: ['Revert "i"', 'Revert "x"'] },
    { base: 'i', args: ['near..i'], expected: ['Revert "i"'] },
    {
      base: 'merge',
      args: ['root..left2', 'root..right2'],
      expected: ['Revert "left2"', 'Revert "left1"', 'Revert "right2"', 'Revert "right1"'],
    },
    {
      base: 'merge3',
      args: ['root..tie3', 'root..tie2'],
      expected: ['Revert "tie3"', 'Revert "tie2"', 'Revert "tie1"'],
    },
    {
      base: 'merge3',
      args: ['root..tie2', 'root..tie3'],
      expected: ['Revert "tie2"', 'Revert "tie3"', 'Revert "tie1"'],
    },
  ])('Given the arguments $args on $base', ({ base, args, expected }) => {
    describe('When git and tsgit revert them', () => {
      it(
        'Then both revert the commits git pins, in its order',
        async () => {
          // Arrange
          const gitDir = copyAt(base);
          tryRunGitWithExit(['-C', gitDir, 'revert', '--no-edit', ...args]);
          const tsgitDir = copyAt(base);
          const repo = await openRepository({ cwd: tsgitDir });
          const sut = repo.revert;

          // Act
          try {
            await sut.run({ commits: args });
          } finally {
            await repo.dispose();
          }

          // Assert
          expect(replayed(gitDir, base)).toEqual(expected);
          expect(replayed(tsgitDir, base)).toEqual(expected);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('interop — an empty commit set', () => {
  describe('Given a range that names no commit', () => {
    describe('When git and tsgit cherry-pick it', () => {
      it(
        'Then both refuse and start no sequence',
        async () => {
          // Arrange
          const gitDir = copyAt('z');
          const gitRun = tryRunGitWithExit(['-C', gitDir, 'cherry-pick', 'left1..left1']);
          const tsgitDir = copyAt('z');
          const repo = await openRepository({ cwd: tsgitDir });
          const sut = repo.cherryPick;

          // Act
          let code: unknown;
          try {
            await sut.run({ commits: ['left1..left1'] });
          } catch (error) {
            code = (error as { data: { code: string } }).data.code;
          } finally {
            await repo.dispose();
          }

          // Assert
          expect(gitRun.stderr.split('\n')[0]).toBe('error: empty commit set passed');
          expect(code).toBe('EMPTY_COMMIT_SET');
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('interop — rebase replay order', () => {
  describe.each([
    { head: 'feat2', upstream: 'up', expected: ['feat1', 'side1', 'side2', 'feat2'] },
    { head: 'skewed3', upstream: 'up', expected: ['skewed1', 'skewed2', 'skewed3'] },
    { head: 'tie4', upstream: 'up', expected: ['tie1', 'tie2', 'tie4'] },
    { head: 'head-tip', upstream: 'upper', expected: ['head-tip'] },
  ])('Given $head rebased onto $upstream', ({ head, upstream, expected }) => {
    describe('When git and tsgit rebase it', () => {
      it(
        'Then both replay the commits git pins, in its order',
        async () => {
          // Arrange
          const gitDir = copyAt(head);
          tryRunGitWithExit(['-C', gitDir, 'rebase', upstream]);
          const tsgitDir = copyAt(head);
          const repo = await openRepository({ cwd: tsgitDir });
          const sut = repo.rebase;

          // Act
          try {
            await sut.run({ upstream });
          } finally {
            await repo.dispose();
          }

          // Assert
          expect(replayed(gitDir, upstream)).toEqual(expected);
          expect(replayed(tsgitDir, upstream)).toEqual(expected);
        },
        ROW_TIMEOUT,
      );
    });
  });
});
