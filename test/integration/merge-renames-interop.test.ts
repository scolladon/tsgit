/**
 * Cross-tool interop — rename detection in the merge core. One history is
 * built by git and copied per tool; each tool then merges, cherry-picks or
 * rebases across a rename, and the resulting tree, unmerged index stages,
 * working-tree files and stop state must agree with canonical git's ort.
 *
 * @proves
 *   surface:        repo.merge.run, repo.cherryPick.run, repo.rebase.run
 *   bucket:         cross-tool-interop
 *   unique:         a file renamed on one side and edited on the other merges into the renamed path as git's ort does
 *   interopSurface: merge
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const EPOCH = 1_700_000_000;
const IDENTITY: AuthorIdentity = {
  name: 't',
  email: 't@t',
  timestamp: EPOCH,
  timezoneOffset: '+0000',
};
const DATED_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: `${EPOCH} +0000`,
  GIT_COMMITTER_DATE: `${EPOCH} +0000`,
  GIT_EDITOR: 'true',
};
const LINES = '1\n2\n3\n4\n5\n6\n7\n8\n';
const STATE_FILES = ['MERGE_HEAD', 'MERGE_MSG', 'CHERRY_PICK_HEAD'];

let root: string;
let copies = 0;

const dated = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): void => {
  runGit(args, { env: { ...DATED_ENV, ...env } });
};

const commitAll = (dir: string, message: string): void => {
  dated(['-C', dir, 'add', '-A']);
  dated(['-C', dir, 'commit', '-q', '-m', message]);
};

const edit = (dir: string, file: string, from: string, to: string): void => {
  const target = path.join(dir, file);
  writeFileSync(target, readFileSync(target, 'utf8').replace(from, to));
};

/** `main` edits `big`; `side` renames it to `big2`, with `sideEdit` applied after the move. */
const buildHistory = (sideEdit?: readonly [string, string]): string => {
  const dir = path.join(root, `history-${copies++}`);
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 't']);
  runGit(['-C', dir, 'config', 'user.email', 't@t']);
  writeFileSync(path.join(dir, 'big'), LINES);
  writeFileSync(path.join(dir, 'f'), 'base\n');
  commitAll(dir, 'base');
  dated(['-C', dir, 'checkout', '-q', '-b', 'side']);
  dated(['-C', dir, 'mv', 'big', 'big2']);
  if (sideEdit !== undefined) edit(dir, 'big2', sideEdit[0], sideEdit[1]);
  commitAll(dir, 'move');
  dated(['-C', dir, 'checkout', '-q', 'main']);
  edit(dir, 'big', '7\n', 'seven\n');
  commitAll(dir, 'edit');
  return dir;
};

const copyOf = async (dir: string): Promise<string> => {
  const target = path.join(root, `copy-${copies++}`);
  await cp(dir, target, { recursive: true });
  return target;
};

const worktreeFiles = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name !== '.git')
      .sort()
      .map((name) => [name, readFileSync(path.join(dir, name), 'utf8')]),
  );

const snapshot = (dir: string) => ({
  tree: git(dir, 'rev-parse', 'HEAD^{tree}').trim(),
  index: git(dir, 'ls-files', '--stage'),
  files: worktreeFiles(dir),
  state: STATE_FILES.filter((name) => existsSync(path.join(dir, '.git', name))),
  mergeMsg: existsSync(path.join(dir, '.git', 'MERGE_MSG'))
    ? readFileSync(path.join(dir, '.git', 'MERGE_MSG'), 'utf8')
    : undefined,
});

describe.skipIf(!GIT_AVAILABLE)('merge rename detection interop', () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-merge-renames-')));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe.each([
    ['an exact rename', undefined],
    ['a rename with a non-overlapping edit', ['1\n', 'one\n'] as const],
    ['a rename with an overlapping edit', ['7\n', 'SEVEN\n'] as const],
  ])('Given %s on the merged side and an edit on HEAD', (_label, sideEdit) => {
    describe('When both tools merge the side', () => {
      it("Then the merge commit, index, files and stop state match git's", async () => {
        // Arrange
        const theirs = buildHistory(sideEdit);
        const ours = await copyOf(theirs);
        tryRunGitWithExit(['-C', theirs, 'merge', 'side'], { env: DATED_ENV });
        const repo = await openRepository({ cwd: ours });
        const sut = repo.merge.run;

        // Act
        await sut({ rev: 'side', author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
        expect(git(ours, 'rev-parse', 'HEAD')).toBe(git(theirs, 'rev-parse', 'HEAD'));
      });
    });
  });

  describe.each([
    ['merge.renames=false', 'merge.renames', 'false'],
    ['diff.renames=false', 'diff.renames', 'false'],
  ])('Given %s', (_label, key, value) => {
    describe('When both tools merge a rename against an edit', () => {
      it('Then both stop on the modify/delete conflict', async () => {
        // Arrange
        const theirs = buildHistory();
        runGit(['-C', theirs, 'config', key, value]);
        const ours = await copyOf(theirs);
        tryRunGitWithExit(['-C', theirs, 'merge', 'side'], { env: DATED_ENV });
        const repo = await openRepository({ cwd: ours });
        const sut = repo.merge.run;

        // Act
        await sut({ rev: 'side', author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });

  describe.each([
    ['an exact rename', undefined],
    ['a rename with an overlapping edit', ['7\n', 'SEVEN\n'] as const],
  ])('Given %s picked onto an edit', (_label, sideEdit) => {
    describe('When both tools cherry-pick the rename', () => {
      it("Then the tree, index, files and stop state match git's", async () => {
        // Arrange
        const theirs = buildHistory(sideEdit);
        const ours = await copyOf(theirs);
        tryRunGitWithExit(['-C', theirs, 'cherry-pick', 'side'], { env: DATED_ENV });
        const repo = await openRepository({ cwd: ours });
        const sut = repo.cherryPick.run;

        // Act
        await sut({ commits: ['side'] });
        await repo.dispose();

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });

  describe('Given an edit rebased onto a rename', () => {
    describe('When both tools rebase HEAD onto the side', () => {
      it("Then the rebased tree and index match git's", async () => {
        // Arrange
        const theirs = buildHistory(['1\n', 'one\n']);
        const ours = await copyOf(theirs);
        tryRunGitWithExit(['-C', theirs, 'rebase', 'side'], { env: DATED_ENV });
        const repo = await openRepository({ cwd: ours });
        const sut = repo.rebase.run;

        // Act
        await sut({ upstream: 'side' });
        await repo.dispose();

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });
});
