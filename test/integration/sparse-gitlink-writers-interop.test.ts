/**
 * Cross-tool interop — a non-cone sparse pattern judges a gitlink the way each writer's git
 * counterpart does when `add` stages and when a merge, cherry-pick or rebase stops on a conflict.
 *
 * @proves
 *   surface:        sparseCheckout
 *   bucket:         cross-tool-interop
 *   unique:         add and the conflict-stopping writers judge a gitlink under a directory-only rule as git does
 *   interopSurface: sparseCheckout
 */
import { mkdir, mkdtemp, readdir, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { cherryPickRun } from '../../src/application/commands/cherry-pick.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { rebaseRun } from '../../src/application/commands/rebase.js';
import { stashApply } from '../../src/application/commands/stash.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';
import { settle } from './skip-worktree-present-files-fixtures.js';

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

const rowOf = (before: string, patterns: string, directory: boolean): Row => ({
  before,
  patterns,
  directory,
});

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
  /** git persists a cleared skip-worktree bit only when it writes the index for another reason; `add` writes it only if an entry is racy or stale, so the index is settled first. */
  readonly writesIndexOpportunistically?: boolean;
}

const ctxOf = (workDir: string) => createNodeContext({ workDir });

const OPERATIONS: ReadonlyArray<Operation> = [
  {
    name: 'adding everything',
    git: ['add', '-A'],
    writesIndexOpportunistically: true,
    tsgit: (workDir) => add(ctxOf(workDir), [], { all: true }),
  },
  {
    name: 'a merge that stops on a conflict',
    git: ['merge', 'other'],
    tsgit: (workDir) => mergeRun(ctxOf(workDir), { rev: 'other' }),
  },
  {
    name: 'a cherry-pick that stops on a conflict',
    git: ['cherry-pick', 'other'],
    tsgit: (workDir) => cherryPickRun(ctxOf(workDir), { commits: ['other'] }),
  },
  {
    name: 'a rebase that stops on a conflict',
    git: ['rebase', 'other'],
    tsgit: (workDir) => rebaseRun(ctxOf(workDir), { upstream: 'other' }),
  },
];

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

interface Observed {
  /** `ls-files -t -s` without object ids, one line per entry joined by `;`. */
  readonly index: string;
  readonly disk: string;
}

interface Gap {
  readonly row: Row;
  readonly operation: string;
  readonly why: string;
  readonly git: Observed;
  readonly tsgit: Observed;
}

const OBJECT_ID = / [0-9a-f]{40} /g;
const STAGED = 'M 100644 1 lib/f;M 100644 2 lib/f;M 100644 3 lib/f';

/** Every row tsgit does not match git on, pinned with what each tool leaves; none is left out of the suite. */
const GAPS: ReadonlyArray<Gap> = [
  {
    row: rowOf(BEFORE[0], PATTERNS[1], true),
    operation: 'a rebase that stops on a conflict',
    why: 'git leaves the present gitlink in the pattern; tsgit skip-worktrees it and removes its directory',
    git: { index: `${STAGED};H 160000 0 sub;H 100644 0 top`, disk: 'lib,lib/f,sub,top' },
    tsgit: { index: `${STAGED};S 160000 0 sub;H 100644 0 top`, disk: 'lib,lib/f,top' },
  },
  {
    row: rowOf(BEFORE[1], PATTERNS[0], false),
    operation: 'a merge that stops on a conflict',
    why: 'git creates the directory of the gitlink it re-includes; tsgit does not',
    git: { index: `${STAGED};H 160000 0 sub;S 100644 0 top`, disk: 'lib,lib/f,sub' },
    tsgit: { index: `${STAGED};H 160000 0 sub;S 100644 0 top`, disk: 'lib,lib/f' },
  },
  {
    row: rowOf(BEFORE[1], PATTERNS[1], true),
    operation: 'a rebase that stops on a conflict',
    why: 'git leaves the present gitlink in the pattern; tsgit skip-worktrees it and removes its directory',
    git: { index: `${STAGED};H 160000 0 sub;H 100644 0 top`, disk: 'lib,lib/f,sub,top' },
    tsgit: { index: `${STAGED};S 160000 0 sub;H 100644 0 top`, disk: 'lib,lib/f,top' },
  },
  {
    row: rowOf(BEFORE[1], PATTERNS[1], false),
    operation: 'a cherry-pick that stops on a conflict',
    why: 'git re-includes the absent gitlink and creates its directory; tsgit leaves it skip-worktree',
    git: { index: `${STAGED};H 160000 0 sub;H 100644 0 top`, disk: 'lib,lib/f,sub,top' },
    tsgit: { index: `${STAGED};S 160000 0 sub;H 100644 0 top`, disk: 'lib,lib/f,top' },
  },
];

const ALL_OPERATIONS: ReadonlyArray<Operation> = [...OPERATIONS, ...CLEAN_OPERATIONS];

const sameRow = (a: Row, b: Row): boolean =>
  a.before === b.before && a.patterns === b.patterns && a.directory === b.directory;

const isPinnedGap = (row: Row, operation: Operation): boolean =>
  GAPS.some((gap) => sameRow(gap.row, row) && gap.operation === operation.name);

const CASES: ReadonlyArray<Case> = ROWS.flatMap((row) =>
  ALL_OPERATIONS.filter((operation) => !isPinnedGap(row, operation)).map((operation) => ({
    ...row,
    operation,
  })),
);

const GAP_CASES = GAPS.map((gap) => ({
  ...gap,
  ...gap.row,
  run: ALL_OPERATIONS.find((operation) => operation.name === gap.operation),
}));

const settleWhenOpportunistic = async (
  operation: Operation,
  repos: ReadonlyArray<string>,
): Promise<void> => {
  if (!operation.writesIndexOpportunistically) return;
  await Promise.all(repos.map((repo) => settle(repo)));
};

const observe = async (repo: string): Promise<Observed> => ({
  index: stateOf(repo).replace(OBJECT_ID, ' ').replace(/\t/g, ' ').trim().split('\n').join(';'),
  disk: (await listDisk(repo)).join(','),
});

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
          await settleWhenOpportunistic(row.operation, [gitRepo, tsgitRepo]);
          runGitToItsStop(gitRepo, row.operation.git);

          // Act
          await row.operation.tsgit(tsgitRepo);

          // Assert
          expect(stateOf(tsgitRepo)).toBe(stateOf(gitRepo));
          expect(await listDisk(tsgitRepo)).toEqual(await listDisk(gitRepo));
        });
      },
    );

    describe.each(GAP_CASES)(
      'Given $patterns after $before and a gitlink sub whose directory is present: $directory, When $operation ($why)',
      (gap) => {
        it('Then git and tsgit each leave what is pinned', async () => {
          // Arrange
          counter += 1;
          const gitRepo = path.join(root, `git-${counter}`);
          const tsgitRepo = path.join(root, `tsgit-${counter}`);
          await seed(gitRepo, gap.row);
          await seed(tsgitRepo, gap.row);
          runGitToItsStop(gitRepo, gap.run?.git ?? []);

          // Act
          await gap.run?.tsgit(tsgitRepo);

          // Assert
          expect(gap.run).toBeDefined();
          expect(await observe(gitRepo)).toEqual(gap.git);
          expect(await observe(tsgitRepo)).toEqual(gap.tsgit);
        });
      },
    );
  },
);
