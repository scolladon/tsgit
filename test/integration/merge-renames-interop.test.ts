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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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

type Step = (dir: string) => void;

const mv =
  (from: string, to: string): Step =>
  (dir) =>
    dated(['-C', dir, 'mv', from, to]);
const rm =
  (file: string): Step =>
  (dir) =>
    dated(['-C', dir, 'rm', '-q', file]);
const put =
  (file: string, content: string): Step =>
  (dir) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };
const configure =
  (key: string, value: string): Step =>
  (dir) =>
    dated(['-C', dir, 'config', key, value]);
const change =
  (file: string, from: string, to: string): Step =>
  (dir) =>
    edit(dir, file, from, to);
const chmodX =
  (file: string): Step =>
  (dir) =>
    dated(['-C', dir, 'update-index', '--chmod=+x', file]);

/** `big` and `y` at the base; `side` then `main` each apply their steps in one commit. */
const buildScenario = (
  sideSteps: ReadonlyArray<Step>,
  mainSteps: ReadonlyArray<Step>,
  baseSteps: ReadonlyArray<Step> = [],
): string => {
  const dir = path.join(root, `scenario-${copies++}`);
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 't']);
  runGit(['-C', dir, 'config', 'user.email', 't@t']);
  writeFileSync(path.join(dir, 'big'), LINES);
  writeFileSync(path.join(dir, 'y'), 'a\nb\nc\nd\ne\nf\ng\nh\n');
  for (const step of baseSteps) step(dir);
  commitAll(dir, 'base');
  dated(['-C', dir, 'checkout', '-q', '-b', 'side']);
  for (const step of sideSteps) step(dir);
  commitAll(dir, 'side');
  dated(['-C', dir, 'checkout', '-q', 'main']);
  for (const step of mainSteps) step(dir);
  commitAll(dir, 'main');
  return dir;
};

const copyOf = async (dir: string): Promise<string> => {
  const target = path.join(root, `copy-${copies++}`);
  await cp(dir, target, { recursive: true });
  return target;
};

const worktreeFiles = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => !name.startsWith('.git') && statSync(path.join(dir, name)).isFile())
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
  describe.each([
    ['rename+edit vs delete', [mv('big', 'big2'), change('big2', '1\n', 'one\n')], [rm('big')]],
    ['delete vs rename', [rm('big')], [mv('big', 'big2')]],
    [
      'rename vs add at its target',
      [mv('big', 'big2')],
      [put('big2', 'x\ny\n'), change('big', '7\n', 'seven\n')],
    ],
    ['rename vs add at its target, source kept', [mv('big', 'big2')], [put('big2', 'x\ny\n')]],
    ['rename/rename to two paths', [mv('big', 'b')], [mv('big', 'a')]],
    ['rename/rename from two paths', [mv('y', 'c')], [mv('big', 'c')]],
    [
      'rename/rename to two paths, both edited',
      [mv('big', 'b'), change('b', '7\n', 'SEVEN\n')],
      [mv('big', 'a'), change('a', '7\n', 'seven\n')],
    ],
    [
      'rename/rename to two paths, both edited apart',
      [mv('big', 'b'), change('b', '1\n', 'one\n')],
      [mv('big', 'a'), change('a', '7\n', 'seven\n')],
    ],
    [
      'rename/rename to two paths, one edited',
      [mv('big', 'b'), change('b', '1\n', 'one\n')],
      [mv('big', 'a')],
    ],
    [
      'the same rename with different edits',
      [mv('big', 'big2'), change('big2', '1\n', 'one\n')],
      [mv('big', 'big2'), change('big2', '7\n', 'seven\n')],
    ],
    [
      'rename with a mode change vs a conflicting edit',
      [mv('big', 'big2'), chmodX('big2'), change('big2', '4\n', 'S\n')],
      [change('big', '4\n', 'M\n')],
    ],
    [
      'rename+edit vs add at its target with an edit of the source',
      [mv('big', 'big2'), change('big2', '1\n', 'one\n')],
      [put('big2', 'x\ny\n'), change('big', '7\n', 'seven\n')],
    ],
    [
      'rename/rename to two paths, one added',
      [mv('big', 'b')],
      [mv('big', 'a'), put('b', 'x\ny\n')],
    ],
    [
      'rename+edit vs add at its target with a conflicting edit of the source',
      [mv('big', 'big2'), change('big2', '1\n', 'one\n')],
      [put('big2', 'x\ny\n'), change('big', '1\n', 'uno\n')],
    ],
    [
      'a content-merged path beside a conflicting one',
      [change('y', 'a\n', 'A\n'), change('big', '4\n', 'S\n')],
      [change('y', 'h\n', 'H\n'), change('big', '4\n', 'M\n')],
    ],
    [
      'rename vs delete and add at its target',
      [mv('big', 'big2')],
      [rm('big'), put('big2', 'x\ny\n')],
    ],
  ] as const)('Given %s', (_label, sideSteps, mainSteps) => {
    describe('When both tools merge the side', () => {
      it("Then the tree, index stages, files and MERGE_MSG match git's", async () => {
        // Arrange
        const theirs = buildScenario(sideSteps, mainSteps);
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

  const IN_DIR = [put('dir/a', LINES), put('dir/b', 'a\nb\nc\nd\ne\nf\ng\nh\n')] as const;
  describe.each([
    [
      'an addition into a directory the side renamed',
      [mv('dir', 'newdir')],
      [put('dir/c', 'c\n')],
      [],
    ],
    [
      'an addition into a renamed directory, directoryRenames=true',
      [mv('dir', 'newdir')],
      [put('dir/c', 'c\n')],
      [configure('merge.directoryRenames', 'true')],
    ],
    [
      'an addition into a renamed directory, directoryRenames=false',
      [mv('dir', 'newdir')],
      [put('dir/c', 'c\n')],
      [configure('merge.directoryRenames', 'false')],
    ],
    [
      'a directory renamed by HEAD the side added into',
      [put('dir/c', 'c\n')],
      [mv('dir', 'newdir')],
      [],
    ],
    ['a rename into a directory the side renamed', [mv('dir', 'newdir')], [mv('y', 'dir/y')], []],
    [
      'a rename into a renamed directory, directoryRenames=true',
      [mv('dir', 'newdir')],
      [mv('y', 'dir/y')],
      [configure('merge.directoryRenames', 'true')],
    ],
    [
      'an addition moved onto the side addition, directoryRenames=true',
      [mv('dir', 'newdir'), put('newdir/c', 'other\n')],
      [put('dir/c', 'c\n')],
      [configure('merge.directoryRenames', 'true')],
    ],
  ] as const)('Given %s', (_label, sideSteps, mainSteps, config) => {
    describe('When both tools merge the side', () => {
      it("Then the tree, index stages, files and MERGE_MSG match git's", async () => {
        // Arrange
        const theirs = buildScenario(sideSteps, mainSteps, [...IN_DIR, ...config]);
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

    describe('When both tools cherry-pick the side', () => {
      it("Then the tree, index stages, files and stop state match git's", async () => {
        // Arrange
        const theirs = buildScenario(sideSteps, mainSteps, [...IN_DIR, ...config]);
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

  describe.each([
    ['rename vs delete', [mv('big', 'big2')], [rm('big')]],
    ['rename/rename to two paths', [mv('big', 'b')], [mv('big', 'a')]],
    [
      'a content-merged path beside a conflicting one',
      [change('y', 'a\n', 'A\n'), change('big', '4\n', 'S\n')],
      [change('y', 'h\n', 'H\n'), change('big', '4\n', 'M\n')],
    ],
    [
      'rename+edit vs add at its target with an edit of the source',
      [mv('big', 'big2'), change('big2', '1\n', 'one\n')],
      [put('big2', 'x\ny\n'), change('big', '7\n', 'seven\n')],
    ],
  ] as const)('Given %s', (_label, sideSteps, mainSteps) => {
    describe('When both tools cherry-pick the side', () => {
      it("Then the tree, index stages, files and stop state match git's", async () => {
        // Arrange
        const theirs = buildScenario(sideSteps, mainSteps);
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

  describe('Given a content-merged path beside a conflicting one', () => {
    describe('When both tools resolve the conflict and commit the merge', () => {
      it("Then the committed tree keeps the merged path as git's does", async () => {
        // Arrange
        const theirs = buildScenario(
          [change('y', 'a\n', 'A\n'), change('big', '4\n', 'S\n')],
          [change('y', 'h\n', 'H\n'), change('big', '4\n', 'M\n')],
        );
        const ours = await copyOf(theirs);
        tryRunGitWithExit(['-C', theirs, 'merge', 'side'], { env: DATED_ENV });
        writeFileSync(path.join(theirs, 'big'), LINES);
        dated(['-C', theirs, 'add', 'big']);
        dated(['-C', theirs, 'commit', '-q', '-m', 'resolved']);
        const repo = await openRepository({ cwd: ours });
        await repo.merge.run({ rev: 'side', author: IDENTITY, committer: IDENTITY });
        writeFileSync(path.join(ours, 'big'), LINES);
        await repo.add(['big']);
        const sut = repo.merge.continue;

        // Act
        await sut({ message: 'resolved', author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        expect(git(ours, 'rev-parse', 'HEAD^{tree}')).toBe(git(theirs, 'rev-parse', 'HEAD^{tree}'));
      });
    });
  });

  describe.each([
    ['find-renames=77', ['1\n', 'one\n'] as const, undefined],
    ['find-renames=78', ['1\n', 'one\n'] as const, undefined],
    ['rename-threshold=70', ['1\n', 'one\n'] as const, undefined],
    ['find-renames=0.77', ['1\n', 'one\n'] as const, undefined],
    ['find-renames=7.5', ['1\n', 'one\n'] as const, undefined],
    ['no-renames', undefined, undefined],
    ['find-renames', undefined, 'false'],
  ])('Given -X %s over a rename and merge.renames=%s', (option, sideEdit, renames) => {
    describe('When both tools merge the side', () => {
      it("Then the merge, index, files and stop state match git's", async () => {
        // Arrange
        const theirs = buildHistory(sideEdit);
        if (renames !== undefined) runGit(['-C', theirs, 'config', 'merge.renames', renames]);
        const ours = await copyOf(theirs);
        tryRunGitWithExit(['-C', theirs, 'merge', '-X', option, 'side'], { env: DATED_ENV });
        const repo = await openRepository({ cwd: ours });
        const sut = repo.merge.run;

        // Act
        await sut({
          rev: 'side',
          strategyOptions: [option],
          author: IDENTITY,
          committer: IDENTITY,
        });
        await repo.dispose();

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
        expect(git(ours, 'rev-parse', 'HEAD')).toBe(git(theirs, 'rev-parse', 'HEAD'));
      });
    });
  });

  describe.each([
    [[], ['bogus'], 128, 'fatal: unknown strategy option: -Xbogus', 'UNKNOWN_STRATEGY_OPTION'],
    [
      ['-s', 'resolve'],
      ['no-renames'],
      2,
      'Merge with strategy resolve failed.',
      'MERGE_STRATEGY_FAILED',
    ],
  ] as const)('Given %j with -X %j', (strategyArgs, options, exitCode, message, code) => {
    describe('When both tools merge a rename against an edit', () => {
      it('Then both refuse and leave the tree as it was', async () => {
        // Arrange
        const theirs = buildHistory();
        const ours = await copyOf(theirs);
        const xargs = options.flatMap((option) => ['-X', option]);
        const gitRun = tryRunGitWithExit(
          ['-C', theirs, 'merge', ...strategyArgs, ...xargs, 'side'],
          {
            env: DATED_ENV,
          },
        );
        const repo = await openRepository({ cwd: ours });
        const strategy = strategyArgs[1];
        const sut = repo.merge.run;

        // Act
        const result = await sut({
          rev: 'side',
          ...(strategy === undefined ? {} : { strategy }),
          strategyOptions: options,
          author: IDENTITY,
        }).catch((error: unknown) => (error as { data: { code: string } }).data.code);
        await repo.dispose();

        // Assert
        expect([gitRun.exitCode, gitRun.stderr.includes(message)]).toEqual([exitCode, true]);
        expect(result).toBe(code);
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });

  describe('Given an exact rename of an untouched path onto a name similar to an edited one', () => {
    describe('When both tools merge the side', () => {
      it("Then the exact pass pairs it first, as git's does", async () => {
        // Arrange
        const theirs = buildScenario(
          [rm('big'), mv('c', 'big2')],
          [change('big', '7\n', 'seven\n')],
          [put('c', `${LINES}9\n`)],
        );
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

  describe('Given two inexact renames against edits and merge.renameLimit=1', () => {
    describe('When both tools merge the side', () => {
      it("Then both skip the similarity pass and tsgit warns with git's lines", async () => {
        // Arrange
        const theirs = buildScenario(
          [
            mv('big', 'big2'),
            change('big2', '1\n', 'one\n'),
            mv('y', 'y2'),
            change('y2', 'a\n', 'A\n'),
          ],
          [change('big', '7\n', 'seven\n'), change('y', 'h\n', 'H\n')],
        );
        runGit(['-C', theirs, 'config', 'merge.renameLimit', '1']);
        const ours = await copyOf(theirs);
        const gitRun = tryRunGitWithExit(['-C', theirs, 'merge', 'side'], { env: DATED_ENV });
        const warnings: string[] = [];
        const repo = await openRepository({
          cwd: ours,
          logger: { warn: (line) => warnings.push(line) },
        });
        const sut = repo.merge.run;

        // Act
        await sut({ rev: 'side', author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
        const gitWarnings = gitRun.stderr
          .split('\n')
          .filter((line) => line.startsWith('warning: '))
          .map((line) => line.slice('warning: '.length));
        expect(gitWarnings).toHaveLength(2);
        expect(warnings).toEqual(gitWarnings);
      });
    });
  });
});
