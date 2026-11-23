/**
 * Cross-tool interop — a directory-only sparse rule judges a tracked file by what stands at its
 * path: a directory there makes it a directory, as git reads the kind of an entry that is not up
 * to date from the work tree, so the file is kept rather than replaced.
 *
 * @proves
 *   surface:        sparseCheckout
 *   bucket:         cross-tool-interop
 *   unique:         a tracked file replaced on disk by a directory is judged a directory under a directory-only rule as git does
 *   interopSurface: sparseCheckout
 */
import { mkdir, mkdtemp, readdir, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { reset } from '../../src/application/commands/reset.js';
import { sparseCheckoutReapply } from '../../src/application/commands/sparse-checkout.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';

const gitIn = (repo: string, args: ReadonlyArray<string>): string =>
  runGit(['-C', repo, ...args], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });

interface Row {
  readonly before: string;
  readonly patterns: string;
}

/** The `before` patterns applied, then `patterns` written and the tracked file `top` replaced by a directory holding `y`. */
const seed = async (repo: string, row: Row): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  await mkdir(path.join(repo, 'lib'));
  await writeFile(path.join(repo, 'lib/f'), 'v1\n');
  await writeFile(path.join(repo, 'top'), 'top\n');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'older']);
  gitIn(repo, ['branch', 'older']);
  await writeFile(path.join(repo, 'lib/f'), 'v2\n');
  gitIn(repo, ['add', 'lib/f']);
  gitIn(repo, ['commit', '-qm', 'main']);
  gitIn(repo, ['config', 'core.sparseCheckout', 'true']);
  gitIn(repo, ['config', 'core.sparseCheckoutCone', 'false']);
  await writeFile(path.join(repo, '.git/info/sparse-checkout'), row.before);
  gitIn(repo, ['read-tree', '-mu', 'HEAD']);
  await writeFile(path.join(repo, '.git/info/sparse-checkout'), row.patterns);
  await removeTree(path.join(repo, 'top'), { force: true });
  await mkdir(path.join(repo, 'top'));
  await writeFile(path.join(repo, 'top/y'), 'y\n');
};

const tagsOf = (repo: string): string =>
  gitIn(repo, ['-c', 'sparse.expectFilesOutsideOfPatterns=true', 'ls-files', '-t']);

const listDisk = async (repo: string): Promise<ReadonlyArray<string>> =>
  (await readdir(repo, { recursive: true })).filter((name) => !name.startsWith('.git')).sort();

const ROWS: ReadonlyArray<Row> = [
  { before: '*\n', patterns: '*\n!top/\n' },
  { before: '*\n', patterns: '/lib/\n' },
  { before: '/lib/\n', patterns: 'top/\n/lib/\n' },
  { before: '/lib/\n', patterns: '*\n!top/\n' },
];

interface Operation {
  readonly name: string;
  readonly git: ReadonlyArray<string>;
  readonly tsgit: (workDir: string) => Promise<unknown>;
}

const ctxOf = (workDir: string) => createNodeContext({ workDir });

const OPERATIONS: ReadonlyArray<Operation> = [
  {
    name: 'reapplying the patterns',
    git: ['sparse-checkout', 'reapply'],
    tsgit: (workDir) => sparseCheckoutReapply(ctxOf(workDir)),
  },
  {
    name: 'switching to an older commit',
    git: ['checkout', '-q', 'older'],
    tsgit: (workDir) => checkout(ctxOf(workDir), { rev: 'older' }),
  },
  {
    name: 'resetting hard to an older commit',
    git: ['reset', '-q', '--hard', 'older'],
    tsgit: (workDir) => reset(ctxOf(workDir), { mode: 'hard', rev: 'older' }),
  },
  {
    name: 'resetting mixed to an older commit',
    git: ['reset', '-q', 'older'],
    tsgit: (workDir) => reset(ctxOf(workDir), { mode: 'mixed', rev: 'older' }),
  },
];

/** git exits non-zero when it cannot remove the directory; what it left is what is compared. */
const runGitToItsEnd = (repo: string, args: ReadonlyArray<string>): void => {
  try {
    gitIn(repo, args);
  } catch {
    // the refusal is the state under test
  }
};

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'a non-cone sparse checkout over a tracked file replaced by a directory',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-sparse-dir-over-file-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    describe.each(ROWS)('Given $patterns after $before', (row) => {
      describe.each(OPERATIONS)('When $name', (operation) => {
        it('Then tsgit leaves the index tags and the files git leaves', async () => {
          // Arrange
          counter += 1;
          const gitRepo = path.join(root, `git-${counter}`);
          const tsgitRepo = path.join(root, `tsgit-${counter}`);
          await seed(gitRepo, row);
          await seed(tsgitRepo, row);
          runGitToItsEnd(gitRepo, operation.git);

          // Act
          await operation.tsgit(tsgitRepo);

          // Assert
          expect(tagsOf(tsgitRepo)).toBe(tagsOf(gitRepo));
          expect(await listDisk(tsgitRepo)).toEqual(await listDisk(gitRepo));
        });
      });
    });
  },
);
