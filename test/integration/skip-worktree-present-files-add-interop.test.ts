/**
 * Cross-tool interop — `add` decides "outside the sparse definition" from the patterns, not
 * only from the skip-worktree bit: a tracked file the patterns exclude stays unstaged and is
 * reported as git reports it even when its bit is cleared on disk, and an untracked path
 * outside the patterns is reported and never staged. Run under both `core.ignorecase` values.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         out-of-pattern paths without the skip-worktree bit stay unstaged and are reported as git does
 *   interopSurface: add
 */
import { mkdir, mkdtemp, readdir, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';

const ADVICE_HEAD = [
  'The following paths and/or pathspecs matched paths that exist',
  'outside of your sparse-checkout definition, so will not be',
  'updated in the index:',
];
const ADVICE_TAIL = [
  'hint: If you intend to update such entries, try one of the following:',
  'hint: * Use the --sparse option.',
  'hint: * Disable or modify the sparsity rules.',
  'hint: Disable this message with "git config set advice.updateSparsePath false"',
];

const adviceOf = (sparse: ReadonlyArray<string>): string =>
  `${[...ADVICE_HEAD, ...sparse, ...ADVICE_TAIL].join('\n')}\n`;

const COMMITTED: Readonly<Record<string, string>> = {
  'a/f': 'base\n',
  'a/g': 'g\n',
  'a/d/x': 'x\n',
  'b/f': 'b\n',
};

const writeFiles = async (repo: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body);
  }
};

const gitIn = (repo: string, args: ReadonlyArray<string>): string =>
  runGit(['-C', repo, ...args], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });

/** Cone /b/ checkout, then "a/f" present on disk with its bit cleared, as a tool that wrote it leaves it. */
const presentOutOfPattern =
  (ignorecase: string, extra: Readonly<Record<string, string>>) =>
  async (repo: string): Promise<void> => {
    runGit(['init', '-q', '-b', 'main', repo]);
    gitIn(repo, ['config', 'core.ignorecase', ignorecase]);
    await writeFiles(repo, COMMITTED);
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c']);
    gitIn(repo, ['sparse-checkout', 'set', '--cone', 'b']);
    gitIn(repo, ['config', 'sparse.expectFilesOutsideOfPatterns', 'true']);
    await writeFiles(repo, { 'a/f': 'hi\n', 'b/f': 'b2\n', ...extra });
    gitIn(repo, ['update-index', '--no-skip-worktree', 'a/f']);
  };

const diskOf = async (repo: string): Promise<string[]> =>
  (await readdir(repo, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(repo, path.join(entry.parentPath, entry.name)))
    .filter((name) => !name.startsWith('.git'))
    .sort();

const snapshotOf = async (repo: string) => ({
  index: gitIn(repo, ['ls-files', '-t', '-s']),
  disk: await diskOf(repo),
});

interface Row {
  readonly label: string;
  readonly flags: ReadonlyArray<string>;
  readonly spec: ReadonlyArray<string>;
  readonly extra: Readonly<Record<string, string>>;
  readonly reported: ReadonlyArray<string>;
}

const NONE: Readonly<Record<string, string>> = {};
const WITH_NEW: Readonly<Record<string, string>> = { 'a/new': 'n\n' };

const ROWS: ReadonlyArray<Row> = [
  { label: 'its name', flags: [], spec: ['a/f'], extra: NONE, reported: ['a/f'] },
  { label: 'its directory', flags: [], spec: ['a'], extra: NONE, reported: ['a'] },
  { label: 'a glob reaching only it', flags: [], spec: ['a/*'], extra: NONE, reported: ['a/*'] },
  { label: '-A', flags: ['-A'], spec: [], extra: NONE, reported: [] },
  { label: 'the whole tree', flags: [], spec: ['.'], extra: NONE, reported: [] },
  {
    label: 'the whole tree with --renormalize',
    flags: ['--renormalize'],
    spec: ['.'],
    extra: NONE,
    reported: [],
  },
  {
    label: 'its name and an in-pattern file',
    flags: [],
    spec: ['a/f', 'b/f'],
    extra: NONE,
    reported: ['a/f'],
  },
  {
    label: 'an untracked out-of-pattern file by name',
    flags: [],
    spec: ['a/new'],
    extra: WITH_NEW,
    reported: ['a/new'],
  },
  {
    label: 'an untracked out-of-pattern file with -A',
    flags: ['-A'],
    spec: [],
    extra: WITH_NEW,
    reported: ['a/new'],
  },
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'add over out-of-pattern files without the skip-worktree bit',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-add-present-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const twins = async (ignorecase: string, extra: Readonly<Record<string, string>>) => {
      counter += 1;
      const gitRepo = path.join(root, `git-${counter}`);
      const tsgitRepo = path.join(root, `tsgit-${counter}`);
      for (const repo of [gitRepo, tsgitRepo]) await presentOutOfPattern(ignorecase, extra)(repo);
      return { gitRepo, tsgitRepo };
    };

    describe.each(['false', 'true'])('with core.ignorecase=%s', (ignorecase) => {
      describe.each(ROWS)('Given $label', ({ flags, spec, extra, reported }) => {
        describe('When git and tsgit add it', () => {
          it('Then both leave the same index and disk, and report alike', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await twins(ignorecase, extra);
            const sut = add;

            // Act
            const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', ...flags, '--', ...spec]);
            const result = await sut(createNodeContext({ workDir: tsgitRepo }), spec, {
              all: flags.includes('-A'),
              renormalize: flags.includes('--renormalize'),
            });

            // Assert
            expect(gitRun.exitCode).toBe(reported.length > 0 ? 1 : 0);
            expect(result.sparse).toEqual(reported);
            expect(gitRun.stderr).toBe(reported.length > 0 ? adviceOf(reported) : '');
            expect(await snapshotOf(tsgitRepo)).toEqual(await snapshotOf(gitRepo));
          });
        });
      });
    });
  },
);
