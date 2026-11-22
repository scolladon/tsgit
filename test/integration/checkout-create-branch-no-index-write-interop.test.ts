/**
 * Cross-tool interop — `checkout -b <name>` with nothing else on the line leaves the index
 * file untouched, as git's only_merge_on_switching_branches does, and passes an unmerged
 * index; a start point, `--no-track` or a sparse out-of-pattern file keep their own effects.
 * Run under both `core.ignorecase` values.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         a checkout -b on the current commit writes no index and passes an unmerged index as git does
 *   interopSurface: checkout
 */
import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { TsgitError } from '../../src/domain/error.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';
const BACKDATE = new Date('2000-01-01T00:00:00Z');
const ROW_TIMEOUT = 60_000;

type CheckoutOptions = Parameters<typeof checkout>[1];

const gitIn = (repo: string, args: ReadonlyArray<string>): string =>
  runGit(['-C', repo, ...args], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });

const commitAll = (repo: string, message: string): void => {
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', message]);
};

const cleanRepo = async (repo: string, ignorecase: string): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'core.ignorecase', ignorecase]);
  await mkdir(path.join(repo, 'a'), { recursive: true });
  await mkdir(path.join(repo, 'b'), { recursive: true });
  await writeFile(path.join(repo, 'a/f'), 'base\n');
  await writeFile(path.join(repo, 'b/f'), 'b\n');
  commitAll(repo, 'c');
};

const sparseRepo = async (repo: string, ignorecase: string): Promise<void> => {
  await cleanRepo(repo, ignorecase);
  gitIn(repo, ['sparse-checkout', 'set', '--cone', 'b']);
  gitIn(repo, ['config', 'sparse.expectFilesOutsideOfPatterns', 'true']);
  await mkdir(path.join(repo, 'a'), { recursive: true });
  await writeFile(path.join(repo, 'a/f'), 'hi\n');
  gitIn(repo, ['update-index', '--no-skip-worktree', 'a/f']);
};

const unmergedRepo = async (repo: string, ignorecase: string): Promise<void> => {
  await cleanRepo(repo, ignorecase);
  gitIn(repo, ['checkout', '-q', '-b', 'side']);
  await writeFile(path.join(repo, 'b/f'), 'side\n');
  commitAll(repo, 'side');
  gitIn(repo, ['checkout', '-q', 'main']);
  await writeFile(path.join(repo, 'b/f'), 'main\n');
  commitAll(repo, 'main');
  tryRunGitWithExit(['-C', repo, 'merge', 'side']);
};

const indexPath = (repo: string): string => path.join(repo, '.git', 'index');

const indexStat = async (repo: string) => {
  const { mtimeMs, ino } = await stat(indexPath(repo));
  return { mtimeMs, ino };
};

const backdate = (repo: string): Promise<void> => utimes(indexPath(repo), BACKDATE, BACKDATE);

const treeOf = (repo: string): string => gitIn(repo, ['ls-files', '-t', '-s']);

interface Row {
  readonly label: string;
  readonly setup: (repo: string, ignorecase: string) => Promise<void>;
  readonly git: ReadonlyArray<string>;
  readonly opts: CheckoutOptions;
  readonly gitExit: number;
  readonly refusal?: Readonly<Record<string, unknown>>;
  readonly rewrites: boolean;
}

const BRANCH = { name: 'other' };

const ROWS: ReadonlyArray<Row> = [
  {
    label: 'checkout -b other',
    setup: cleanRepo,
    git: ['checkout', '-b', 'other'],
    opts: { createBranch: BRANCH },
    gitExit: 0,
    rewrites: false,
  },
  {
    label: 'checkout -b other HEAD',
    setup: cleanRepo,
    git: ['checkout', '-b', 'other', 'HEAD'],
    opts: { rev: 'HEAD', createBranch: BRANCH },
    gitExit: 0,
    rewrites: true,
  },
  {
    label: 'checkout -b other --no-track',
    setup: cleanRepo,
    git: ['checkout', '-b', 'other', '--no-track'],
    opts: { createBranch: { ...BRANCH, noTrack: true } },
    gitExit: 0,
    rewrites: true,
  },
  {
    label: 'checkout -b other over a present out-of-pattern file',
    setup: sparseRepo,
    git: ['checkout', '-b', 'other'],
    opts: { createBranch: BRANCH },
    gitExit: 0,
    rewrites: false,
  },
  {
    label: 'checkout -b other over an unmerged index',
    setup: unmergedRepo,
    git: ['checkout', '-b', 'other'],
    opts: { createBranch: BRANCH },
    gitExit: 0,
    rewrites: false,
  },
  {
    label: 'checkout -b other HEAD over an unmerged index',
    setup: unmergedRepo,
    git: ['checkout', '-b', 'other', 'HEAD'],
    opts: { rev: 'HEAD', createBranch: BRANCH },
    gitExit: 1,
    refusal: { code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['b/f'] },
    rewrites: false,
  },
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'checkout -b on the current commit',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-co-b-')));
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    describe.each(['false', 'true'])('with core.ignorecase=%s', (ignorecase) => {
      describe.each(ROWS)('Given $label', ({ setup, git, opts, gitExit, refusal, rewrites }) => {
        describe('When git and tsgit run it', () => {
          it(
            'Then both treat the index file alike and leave the same entries',
            async () => {
              // Arrange
              counter += 1;
              const gitRepo = path.join(root, `git-${counter}`);
              const tsgitRepo = path.join(root, `tsgit-${counter}`);
              for (const repo of [gitRepo, tsgitRepo]) {
                await setup(repo, ignorecase);
                await backdate(repo);
              }
              const before = new Map<string, Awaited<ReturnType<typeof indexStat>>>();
              for (const repo of [gitRepo, tsgitRepo]) before.set(repo, await indexStat(repo));
              const sut = checkout;

              // Act
              const gitRun = tryRunGitWithExit(['-C', gitRepo, ...git]);
              const failure = await sut(createNodeContext({ workDir: tsgitRepo }), opts).then(
                () => undefined,
                (error: unknown) => error,
              );

              // Assert
              expect(gitRun.exitCode).toBe(gitExit);
              if (refusal === undefined) expect(failure).toBeUndefined();
              else {
                expect(failure).toBeInstanceOf(TsgitError);
                expect((failure as TsgitError).data).toEqual(refusal);
              }
              const rewritten = async (repo: string): Promise<boolean> => {
                const now = await indexStat(repo);
                const prior = before.get(repo);
                return now.mtimeMs !== prior?.mtimeMs || now.ino !== prior?.ino;
              };
              expect(await rewritten(gitRepo)).toBe(rewrites);
              expect(await rewritten(tsgitRepo)).toBe(rewrites);
              expect(treeOf(tsgitRepo)).toBe(treeOf(gitRepo));
              expect(gitIn(tsgitRepo, ['symbolic-ref', 'HEAD'])).toBe(
                gitIn(gitRepo, ['symbolic-ref', 'HEAD']),
              );
            },
            ROW_TIMEOUT,
          );
        });
      });
    });
  },
);
