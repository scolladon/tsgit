/**
 * Cross-tool interop — a non-cone sparse pattern judges a gitlink the way each writer's git
 * counterpart does: a merge or a stash apply, which refresh the index first, take a skip-worktree
 * gitlink as a directory, and a cherry-pick or a rebase, which do not, judge it by what stands at its path.
 *
 * @proves
 *   surface:        sparseCheckout
 *   bucket:         cross-tool-interop
 *   unique:         merge, stash apply, cherry-pick and rebase judge a gitlink under a directory-only rule as git does
 *   interopSurface: sparseCheckout
 */
import { mkdir, mkdtemp, readdir, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { cherryPickRun } from '../../src/application/commands/cherry-pick.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { rebaseRun } from '../../src/application/commands/rebase.js';
import { stashApply } from '../../src/application/commands/stash.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';
const GITLINK_ID = '1111111111111111111111111111111111111111';

const gitIn = (repo: string, args: ReadonlyArray<string>): string =>
  runGit(['-C', repo, ...args], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });

/** Both branches change lib/f, `other` also top, so merging them stops on lib/f; `clean` changes only top and a stash holds another lib/f; the `before` patterns applied, then `patterns` written and the gitlink's directory made present or absent. */
const seed = async (repo: string, row: Row): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  await mkdir(path.join(repo, 'lib'));
  await writeFile(path.join(repo, 'lib/f'), 'base\n');
  await writeFile(path.join(repo, 'top'), 'top\n');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['update-index', '--add', '--cacheinfo', `160000,${GITLINK_ID},sub`]);
  gitIn(repo, ['commit', '-qm', 'base']);
  gitIn(repo, ['branch', 'base']);
  gitIn(repo, ['branch', 'other']);
  await writeFile(path.join(repo, 'lib/f'), 'main\n');
  gitIn(repo, ['add', 'lib/f']);
  gitIn(repo, ['commit', '-qm', 'main']);
  gitIn(repo, ['checkout', '-q', 'other']);
  await writeFile(path.join(repo, 'lib/f'), 'other\n');
  await writeFile(path.join(repo, 'top'), 'other top\n');
  gitIn(repo, ['add', 'lib/f', 'top']);
  gitIn(repo, ['commit', '-qm', 'other']);
  gitIn(repo, ['checkout', '-q', '-b', 'clean', 'base']);
  await writeFile(path.join(repo, 'top'), 'clean top\n');
  gitIn(repo, ['add', 'top']);
  gitIn(repo, ['commit', '-qm', 'clean']);
  gitIn(repo, ['checkout', '-q', 'main']);
  await writeFile(path.join(repo, 'lib/f'), 'stashed\n');
  gitIn(repo, ['stash', 'push', '-q']);
  gitIn(repo, ['config', 'core.sparseCheckout', 'true']);
  gitIn(repo, ['config', 'core.sparseCheckoutCone', 'false']);
  await writeFile(path.join(repo, '.git/info/sparse-checkout'), row.before);
  gitIn(repo, ['read-tree', '-mu', 'HEAD']);
  await writeFile(path.join(repo, '.git/info/sparse-checkout'), row.patterns);
  await removeTree(path.join(repo, 'sub'), { recursive: true, force: true });
  if (row.directory) await mkdir(path.join(repo, 'sub'));
};

const stateOf = (repo: string): string =>
  gitIn(repo, ['-c', 'sparse.expectFilesOutsideOfPatterns=true', 'ls-files', '-t', '-s']);

const listDisk = async (repo: string): Promise<ReadonlyArray<string>> =>
  (await readdir(repo, { recursive: true })).filter((name) => !name.startsWith('.git')).sort();

interface Row {
  readonly before: string;
  readonly patterns: string;
  readonly directory: boolean;
}

const BEFORE = ['*\n', '/lib/\n'] as const;
const PATTERNS = ['sub/\n/lib/\n', '*\n!sub/\n'] as const;

const ROWS: ReadonlyArray<Row> = BEFORE.flatMap((before) =>
  PATTERNS.flatMap((patterns) => [
    { before, patterns, directory: true },
    { before, patterns, directory: false },
  ]),
);

interface Operation {
  readonly name: string;
  readonly git: ReadonlyArray<string>;
  readonly tsgit: (workDir: string) => Promise<unknown>;
}

const ctxOf = (workDir: string) => createNodeContext({ workDir });

const CLEAN_OPERATIONS: ReadonlyArray<Operation> = [
  {
    name: 'applying a stash',
    git: ['stash', 'apply'],
    tsgit: (workDir) => stashApply(ctxOf(workDir)),
  },
  {
    name: 'a merge that completes',
    git: ['merge', '-m', 'm', 'clean'],
    tsgit: (workDir) => mergeRun(ctxOf(workDir), { rev: 'clean', message: 'm' }),
  },
  {
    name: 'a cherry-pick that completes',
    git: ['cherry-pick', 'clean'],
    tsgit: (workDir) => cherryPickRun(ctxOf(workDir), { commits: ['clean'] }),
  },
  {
    name: 'a rebase that completes',
    git: ['rebase', 'clean'],
    tsgit: (workDir) => rebaseRun(ctxOf(workDir), { upstream: 'clean' }),
  },
];

/** git exits non-zero on the conflict it stops at; what it left is what is compared. */
const runGitToItsStop = (repo: string, args: ReadonlyArray<string>): void => {
  try {
    gitIn(repo, args);
  } catch {
    // the stop is the state under test
  }
};

interface Case extends Row {
  readonly operation: Operation;
}

const CASES: ReadonlyArray<Case> = ROWS.flatMap((row) =>
  CLEAN_OPERATIONS.map((operation) => ({ ...row, operation })),
);

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'a non-cone sparse checkout over a gitlink',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-sparse-writers-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    describe.each(CASES)(
      'Given $patterns after $before and a gitlink sub whose directory is present: $directory, When $operation.name',
      (row) => {
        it('Then tsgit leaves the index and the files git leaves', async () => {
          // Arrange
          counter += 1;
          const gitRepo = path.join(root, `git-${counter}`);
          const tsgitRepo = path.join(root, `tsgit-${counter}`);
          await seed(gitRepo, row);
          await seed(tsgitRepo, row);
          runGitToItsStop(gitRepo, row.operation.git);

          // Act
          await row.operation.tsgit(tsgitRepo);

          // Assert
          expect(stateOf(tsgitRepo)).toBe(stateOf(gitRepo));
          expect(await listDisk(tsgitRepo)).toEqual(await listDisk(gitRepo));
        });
      },
    );
  },
);
