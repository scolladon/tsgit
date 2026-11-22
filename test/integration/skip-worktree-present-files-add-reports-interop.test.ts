/**
 * Cross-tool interop — `add` reports what git reports when sparse checkout and the work tree
 * disagree: a symlink that takes the place of a tracked out-of-pattern directory removes nothing
 * the patterns leave alone, and an untracked, gitignored, out-of-pattern path is reported as
 * ignored, not as outside the sparse definition.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         add reports removed and ignored paths under a cone checkout as git does
 *   interopSurface: add
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm as removeTree,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';

const gitIn = (repo: string, args: ReadonlyArray<string>): string =>
  runGit(['-C', repo, ...args], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });

const writeFiles = async (repo: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body);
  }
};

const commitAll = (repo: string, cone: ReadonlyArray<string>): void => {
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'c']);
  gitIn(repo, ['sparse-checkout', 'set', '--cone', ...cone]);
};

/** Tracked "d/x" out of the cone, an untracked "t/x", and a symlink "d" -> "t" where the directory was. */
const symlinkOverDirectory = async (repo: string): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  await writeFiles(repo, { 'd/x': 'x\n', top: 'top\n' });
  commitAll(repo, []);
  await writeFiles(repo, { 't/x': 'x\n' });
  await symlink('t', path.join(repo, 'd'));
};

const diskOf = async (repo: string): Promise<string[]> =>
  (await readdir(repo, { recursive: true })).filter((name) => !name.startsWith('.git')).sort();

const linesAfter = (output: string, header: RegExp): string[] => {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('hint:'));
  return rest
    .slice(0, end < 0 ? rest.length : end)
    .filter((line) => !line.startsWith('outside') && !line.startsWith('updated'));
};

const verbOf = (output: string, verb: string): string[] =>
  output
    .split('\n')
    .filter((line) => line.startsWith(`${verb} '`))
    .map((line) => line.slice(verb.length + 2, -1))
    .sort();

interface Row {
  readonly label: string;
  readonly seed: (repo: string) => Promise<void>;
  readonly flags: ReadonlyArray<string>;
  readonly spec: ReadonlyArray<string>;
}

const ROWS: ReadonlyArray<Row> = [
  {
    label: 'a symlink over an out-of-pattern directory, by name',
    seed: symlinkOverDirectory,
    flags: [],
    spec: ['d'],
  },
  {
    label: 'a symlink over an out-of-pattern directory, by glob',
    seed: symlinkOverDirectory,
    flags: [],
    spec: ['*'],
  },
  {
    label: 'a symlink over an out-of-pattern directory, with -A',
    seed: symlinkOverDirectory,
    flags: ['-A'],
    spec: [],
  },
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'add reports over a sparse checkout',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-add-reports-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    describe.each(ROWS)('Given $label', ({ seed, flags, spec }) => {
      describe('When git and tsgit add it', () => {
        it('Then both leave the same index and disk, and report alike', async () => {
          // Arrange
          counter += 1;
          const gitRepo = path.join(root, `git-${counter}`);
          const tsgitRepo = path.join(root, `tsgit-${counter}`);
          await seed(gitRepo);
          await seed(tsgitRepo);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '-v', ...flags, '--', ...spec]);
          const result = await sut(createNodeContext({ workDir: tsgitRepo }), spec, {
            all: flags.includes('-A'),
          });

          // Assert
          const tags = ['-c', 'sparse.expectFilesOutsideOfPatterns=true', 'ls-files', '-t', '-s'];
          expect(result.removed).toEqual(verbOf(gitRun.stdout, 'remove'));
          expect(result.ignored).toEqual(
            linesAfter(gitRun.stderr, /^The following paths are ignored/),
          );
          expect(result.sparse).toEqual(
            linesAfter(gitRun.stderr, /^The following paths and\/or pathspecs matched/),
          );
          expect(gitIn(tsgitRepo, tags)).toBe(gitIn(gitRepo, tags));
          expect(await diskOf(tsgitRepo)).toEqual(await diskOf(gitRepo));
        });
      });
    });
  },
);
