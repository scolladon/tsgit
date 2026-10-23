/**
 * Cross-tool interop — `add` reports the ignored entries a pathspec reaches on the
 * walk and leaves them unstaged, as git does: it lists them, exits 1 and prints
 * the advice block, while a missing or unmatched pathspec is still refused first.
 * `force` is git's `-f` on every route: no ignore rule applies.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         add reports ignored entries a pathspec reaches as git does
 *   interopSurface: add
 */
import { mkdir, mkdtemp, readdir, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { type AddResult, add } from '../../src/application/commands/add.js';
import { TsgitError } from '../../src/domain/index.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';
const GIT_REFUSED = 128;
const GIT_REPORTED = 1;

type Files = Readonly<Record<string, string>>;
type Setup = (repo: string) => Promise<void>;

const snapshotOf = (repo: string) => ({
  index: runGit(['-C', repo, 'ls-files', '-s']),
  status: runGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']),
});

const looseCountOf = async (repo: string): Promise<number> => {
  const prefixes = (await readdir(path.join(repo, '.git', 'objects'))).filter((name) =>
    /^[0-9a-f]{2}$/.test(name),
  );
  const counts = await Promise.all(
    prefixes.map(
      async (prefix) => (await readdir(path.join(repo, '.git', 'objects', prefix))).length,
    ),
  );
  return counts.reduce((sum, count) => sum + count, 0);
};

const writeFiles = async (repo: string, files: Files): Promise<void> => {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body);
  }
};

const commitAll = (repo: string): void => {
  runGit(['-C', repo, 'add', '-A']);
  runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c'], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });
};

/** Commits `files`, then lays `.gitignore` and the working-tree edits down. */
const trackedThen =
  (files: Files, rules: string, edits: Files): Setup =>
  async (repo) => {
    await writeFiles(repo, files);
    commitAll(repo);
    await writeFiles(repo, { '.gitignore': rules, ...edits });
  };

/** Nothing tracked: every log and the directory d are ignored. */
const untracked: Setup = (repo) =>
  writeFiles(repo, {
    '.gitignore': '*.log\nd/\n',
    'x.log': 'x\n',
    'y.log': 'y\n',
    'real.txt': 'r\n',
    'd/q.txt': 'q\n',
  });

/** d/x.txt and k tracked, then d hidden, d/x.txt rewritten, d/new.txt untracked. */
const trackedUnderIgnoredDirectory: Setup = trackedThen({ 'd/x.txt': 'a\n', k: 'k\n' }, 'd/\n', {
  'd/x.txt': 'bb\n',
  'd/new.txt': 'n\n',
});

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'add reporting the ignored entries a pathspec reaches',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-add-ignored-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const twins = async (setup: Setup) => {
      counter += 1;
      const gitRepo = path.join(root, `git-${counter}`);
      const tsgitRepo = path.join(root, `tsgit-${counter}`);
      for (const repo of [gitRepo, tsgitRepo]) {
        runGit(['init', '-q', '-b', 'main', repo]);
        await setup(repo);
      }
      return { gitRepo, tsgitRepo };
    };

    const outcomeOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        return await run();
      } catch (error) {
        return error;
      }
    };

    describe.each([
      { label: 'a wildcard that matches nothing', setup: untracked, spec: ['nomatch*', '*.txt'] },
      { label: 'a missing literal', setup: untracked, spec: ['missing', '*.txt'] },
      {
        label: 'a wildcard reaching only an ignored log',
        setup: untracked,
        spec: ['x.lo?', '*.txt'],
      },
      {
        label: 'a wildcard reaching nothing beneath an ignored directory holding a tracked file',
        setup: trackedUnderIgnoredDirectory,
        spec: ['d/n*'],
      },
    ])('Given $label', ({ setup, spec }) => {
      describe('When git and tsgit add it', () => {
        it('Then both leave the same index, status and loose objects', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const sut = add;

          // Act
          tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec]);
          await outcomeOf(() => sut(createNodeContext({ workDir: tsgitRepo }), spec));

          // Assert
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
          expect(await looseCountOf(tsgitRepo)).toBe(await looseCountOf(gitRepo));
        });
      });

      describe('When git and tsgit add it and git refuses', () => {
        it('Then tsgit refuses with the same pathspec', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec]);
          const outcome = await outcomeOf(() =>
            sut(createNodeContext({ workDir: tsgitRepo }), spec),
          );

          // Assert
          const refused = gitRun.exitCode === GIT_REFUSED;
          expect(outcome instanceof TsgitError).toBe(refused);
          if (!refused) return;
          const named = /pathspec '(.*)' did not match/.exec(gitRun.stderr)?.[1];
          expect((outcome as TsgitError).data).toMatchObject({
            code: 'PATHSPEC_NO_MATCH',
            pattern: named,
          });
        });
      });
    });

    /** git's advice block, rebuilt from the structured `ignored` list. */
    const adviceFor = (ignored: ReadonlyArray<string>): string =>
      [
        'The following paths are ignored by one of your .gitignore files:',
        ...ignored,
        'hint: Use -f if you really want to add them.',
        'hint: Disable this message with "git config set advice.addIgnoredFile false"',
        '',
      ].join('\n');

    const trackedHiddenBuild: Setup = trackedThen({ k: 'k\n' }, 'build/\n', {
      k: 'kk\n',
      'build/x': 'x\n',
    });
    const trackedHiddenLog: Setup = trackedThen({ 't.log': 'a\n', k: 'k\n' }, '*.log\n', {
      't.log': 'bb\n',
      'u.log': 'u\n',
    });

    describe.each([
      {
        label: 'an ignored literal beside a wildcard reaching a text file',
        setup: untracked,
        spec: ['x.log', '*.txt'],
      },
      { label: 'the ignored directory', setup: untracked, spec: ['d'] },
      { label: 'the ignored directory spelled with a slash', setup: untracked, spec: ['d/'] },
      {
        label: 'repeated and unsorted ignored literals',
        setup: untracked,
        spec: ['y.log', 'x.log', 'y.log', 'd/q.txt', 'd'],
      },
      {
        label: 'the ignored directory over a tracked file',
        setup: trackedUnderIgnoredDirectory,
        spec: ['d'],
      },
      {
        label: 'a wildcard inside the ignored directory',
        setup: trackedUnderIgnoredDirectory,
        spec: ['d/*.txt'],
      },
      {
        label: 'a wildcard naming the ignored directory',
        setup: trackedUnderIgnoredDirectory,
        spec: ['d*'],
      },
      {
        label: 'a wildcard on the tracked file inside the ignored directory',
        setup: trackedUnderIgnoredDirectory,
        spec: ['d/x*'],
      },
      {
        label: 'a single-character wildcard reaching only the directory and a clean file',
        setup: trackedUnderIgnoredDirectory,
        spec: ['?'],
      },
      {
        label: 'a wildcard reaching every top-level name',
        setup: trackedUnderIgnoredDirectory,
        spec: ['*'],
      },
      {
        label: 'a literal beneath an ignored directory beside a wildcard on a tracked file',
        setup: trackedHiddenBuild,
        spec: ['build/x', 'k*'],
      },
      {
        label: 'a tracked log a rule hides, by wildcard',
        setup: trackedHiddenLog,
        spec: ['*.log'],
      },
      { label: 'a tracked log a rule hides, by dot', setup: trackedHiddenLog, spec: ['.'] },
      {
        label: 'a tracked log a rule hides, by single-character wildcard',
        setup: trackedHiddenLog,
        spec: ['?.log'],
      },
    ])('Given $label', ({ setup, spec }) => {
      describe('When git and tsgit add it', () => {
        it('Then both leave the same index, status and loose objects', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const sut = add;

          // Act
          tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec]);
          await sut(createNodeContext({ workDir: tsgitRepo }), spec);

          // Assert
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
          expect(await looseCountOf(tsgitRepo)).toBe(await looseCountOf(gitRepo));
        });
      });

      describe('When git and tsgit add it and git prints its advice', () => {
        it('Then ignored is non-empty exactly when git exits 1 and rebuilds the same block', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec]);
          const result: AddResult = await sut(createNodeContext({ workDir: tsgitRepo }), spec);

          // Assert
          const reported = result.ignored.length > 0;
          expect(gitRun.exitCode === GIT_REPORTED).toBe(reported);
          expect(gitRun.stderr).toBe(reported ? adviceFor(result.ignored) : '');
        });
      });
    });

    describe.each([
      { label: 'a wildcard on the ignored suffix', setup: untracked, spec: ['*.log'] },
      { label: 'the whole tree', setup: untracked, spec: ['.'] },
      { label: 'the ignored directory', setup: untracked, spec: ['d'] },
      { label: 'an ignored literal beside a wildcard', setup: untracked, spec: ['x.log', '*.txt'] },
    ])('Given every log and a directory are ignored and $label', ({ setup, spec }) => {
      describe('When git add -f and tsgit add with force run', () => {
        it('Then both leave the same index, status and loose objects and report nothing', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '-f', '--', ...spec]);
          const result = await sut(createNodeContext({ workDir: tsgitRepo }), spec, {
            force: true,
          });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(result.ignored).toEqual([]);
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
          expect(await looseCountOf(tsgitRepo)).toBe(await looseCountOf(gitRepo));
        });
      });
    });

    describe('Given every log and a directory are ignored', () => {
      describe('When git add -A -f and tsgit add with all and force run', () => {
        it('Then both leave the same index, status and loose objects', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(untracked);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '-A', '-f']);
          const result = await sut(createNodeContext({ workDir: tsgitRepo }), [], {
            all: true,
            force: true,
          });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(result.ignored).toEqual([]);
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
          expect(await looseCountOf(tsgitRepo)).toBe(await looseCountOf(gitRepo));
        });
      });
    });
  },
);
