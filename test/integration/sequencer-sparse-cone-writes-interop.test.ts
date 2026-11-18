/**
 * Cross-tool interop — sparse patterns govern every merge-driven work-tree write.
 * Each row seeds two identical repositories, runs one operation in canonical git
 * and in tsgit, and compares the index tags, the work tree and the outcome.
 *
 * @proves
 *   surface:        repo.checkout, repo.reset, repo.merge.run, pull
 *   bucket:         cross-tool-interop
 *   unique:         sparse patterns govern every merge-driven work-tree write, case-folded under core.ignorecase, as canonical git applies them
 *   interopSurface: sequencer, stash, checkout, merge
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { pull } from '../../src/application/commands/pull.js';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import { backendTransport } from './http-backend-transport.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import {
  COMMIT_ENV,
  commitOn,
  listing,
  regular,
  type TreeEntry,
} from './occupant-displacement-fixtures.js';
import { trackedContexts } from './repository-lifecycle.js';

const CONE_FILE = '/*\n!/*/\n/b/\n';
const NON_CONE_FILE = '/top\n/b/\n';
const ORIGIN_URL = 'https://example.com/origin.git';
const ROW_TIMEOUT = 60_000;
const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;
const LEFT_HEADER = 'The following paths are not up to date and were left despite sparse patterns:';

const createTrackedNodeContext = trackedContexts(createNodeContext);

interface Seed {
  readonly main: ReadonlyArray<TreeEntry>;
  readonly other: ReadonlyArray<TreeEntry>;
}

const CASE_SEED: Seed = {
  main: [regular('B/f', 'f1\n'), regular('x/y', 'y1\n'), regular('top', 't\n')],
  other: [regular('B/f', 'f2\n'), regular('x/y', 'y2\n'), regular('top', 't\n')],
};

const seedTwin = (dir: string, ignoreCase: string, seed: Seed): void => {
  runGit(['-C', dir, 'config', 'core.ignorecase', ignoreCase]);
  const main = commitOn(dir, seed.main);
  const other = commitOn(dir, seed.other, main);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/other', other]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

const enableSparse = (dir: string, { cone }: { readonly cone: boolean }): void => {
  runGit(['-C', dir, 'config', 'core.sparseCheckout', 'true']);
  runGit(['-C', dir, 'config', 'core.sparseCheckoutCone', String(cone)]);
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(dir, '.git', 'info', 'sparse-checkout'), cone ? CONE_FILE : NON_CONE_FILE);
  runGit(['-C', dir, 'read-tree', '-mu', 'HEAD']);
};

const tagged = (dir: string): string => runGit(['-C', dir, 'ls-files', '-t', '-s']);

type Outcome = { readonly kind: 'ok' } | { readonly kind: 'error'; readonly code: string };

const outcomeOf = async (run: () => Promise<unknown>): Promise<Outcome> => {
  try {
    await run();
    return { kind: 'ok' };
  } catch (error) {
    if (error instanceof TsgitError) return { kind: 'error', code: error.data.code };
    throw error;
  }
};

const leftWarning = (stderr: string): ReadonlyArray<string> =>
  stderr.split('\n').filter((line) => line.includes(LEFT_HEADER));
const leftWarnings = (warnings: ReadonlyArray<string>): ReadonlyArray<string> =>
  warnings.filter((warning) => warning.startsWith(LEFT_HEADER));

const gitExitOf = (dir: string, args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, ...args], { env: COMMIT_ENV });

interface TsgitRun {
  readonly outcome: Outcome;
  readonly warnings: ReadonlyArray<string>;
}

const runTsgit = async (
  dir: string,
  operation: (repo: Repository) => Promise<unknown>,
): Promise<TsgitRun> => {
  const warnings: string[] = [];
  const repo = await openRepository({
    cwd: dir,
    logger: { warn: (message: string) => warnings.push(message) },
  });
  try {
    return { outcome: await outcomeOf(() => operation(repo)), warnings };
  } finally {
    await repo.dispose();
  }
};

interface CaseRow {
  readonly id: string;
  readonly gitArgs: ReadonlyArray<string>;
  readonly operation: (repo: Repository) => Promise<unknown>;
}

const CASE_ROWS: ReadonlyArray<CaseRow> = [
  {
    id: 'case-checkout',
    gitArgs: ['checkout', '-q', 'other'],
    operation: (repo) => repo.checkout({ rev: 'other' }),
  },
  {
    id: 'case-reset',
    gitArgs: ['reset', '-q', '--hard', 'other'],
    operation: (repo) => repo.reset({ mode: 'hard', rev: 'other' }),
  },
  {
    id: 'case-merge',
    gitArgs: ['merge', '-q', 'other'],
    operation: (repo) => repo.merge.run({ rev: 'other', message: 'm', author: AUTHOR }),
  },
];

const BASE_SEED: Seed = {
  main: [
    regular('a/f', 'f1\n'),
    regular('a/g', 'g1\n'),
    regular('b/f', 'f1\n'),
    regular('top', 't\n'),
  ],
  other: [
    regular('a/f', 'f2\n'),
    regular('a/g', 'g1\n'),
    regular('b/f', 'f2\n'),
    regular('top', 't\n'),
  ],
};

interface MoverRow {
  readonly id: string;
  readonly edit: (dir: string) => void;
  readonly expectedListing: ReadonlyArray<string>;
  readonly expectedWarning: string | undefined;
}

const REAPPLY_HINT =
  '\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.';

const MOVER_ROWS: ReadonlyArray<MoverRow> = [
  {
    id: 'dirty-mover-kept',
    edit: (dir) => writeFileSync(join(dir, 'a', 'g'), 'dirty\n'),
    expectedListing: ['a/', 'a/g=dirty\n', 'b/', 'b/f=f2\n', 'top=t\n'],
    expectedWarning: `${LEFT_HEADER}\n\ta/g\n${REAPPLY_HINT}`,
  },
  {
    id: 'clean-mover-removed',
    edit: () => undefined,
    expectedListing: ['b/', 'b/f=f2\n', 'top=t\n'],
    expectedWarning: undefined,
  },
];

const presentMover = (dir: string): void => {
  runGit(['-C', dir, 'update-index', '--no-skip-worktree', 'a/g']);
  runGit(['-C', dir, 'checkout', '--', 'a/g']);
};

const expectedCaseListing = (ignoreCase: string): ReadonlyArray<string> =>
  ignoreCase === 'true' ? ['B/', 'B/f=f2\n', 'top=t\n'] : ['top=t\n'];

describe.skipIf(!GIT_AVAILABLE)('sequencer sparse cone writes interop', () => {
  let pair: PeerPair;
  const extraDirs: string[] = [];

  beforeEach(async () => {
    pair = await makePeerPair('sequencer-sparse');
    initBothRepos(pair.peer, pair.ours);
    for (const dir of [pair.peer, pair.ours]) {
      runGit(['-C', dir, 'config', 'user.name', 'Ada']);
      runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
    }
  });

  afterEach(async () => {
    await pair.dispose();
    for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe.each(['false', 'true'] as const)(
    'Given core.ignorecase=%s in both twins',
    (ignoreCase) => {
      describe('When a cone-mode operation brings in a differently cased cone directory', () => {
        it.skipIf(!GIT_AVAILABLE).each(CASE_ROWS)(
          'Then $id leaves the same index tags and work tree as git',
          async ({ gitArgs, operation }) => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              seedTwin(dir, ignoreCase, CASE_SEED);
              enableSparse(dir, { cone: true });
            }

            // Act
            const git = gitExitOf(pair.peer, gitArgs);
            const run = await runTsgit(pair.ours, operation);

            // Assert
            expect(git.exitCode).toBe(0);
            expect(run.outcome).toEqual({ kind: 'ok' });
            expect(tagged(pair.ours)).toBe(tagged(pair.peer));
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
            expect(listing(pair.ours)).toEqual(expectedCaseListing(ignoreCase));
            expect(leftWarnings(run.warnings)).toEqual(leftWarning(git.stderr));
          },
        );
      });

      describe('When checkout switches over an out-of-pattern file that is present', () => {
        it.skipIf(!GIT_AVAILABLE).each(MOVER_ROWS)(
          'Then $id leaves the same index tags, work tree and warning as git',
          async ({ edit, expectedListing, expectedWarning }) => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              seedTwin(dir, ignoreCase, BASE_SEED);
              enableSparse(dir, { cone: true });
              presentMover(dir);
              edit(dir);
            }

            // Act
            const git = gitExitOf(pair.peer, ['checkout', '-q', 'other']);
            const run = await runTsgit(pair.ours, (repo) => repo.checkout({ rev: 'other' }));

            // Assert
            expect(git.exitCode).toBe(0);
            expect(run.outcome).toEqual({ kind: 'ok' });
            expect(tagged(pair.ours)).toBe(tagged(pair.peer));
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
            expect(listing(pair.ours)).toEqual(expectedListing);
            expect(leftWarnings(run.warnings)).toEqual(
              expectedWarning === undefined ? [] : [expectedWarning],
            );
            expect(git.stderr).toContain(
              expectedWarning === undefined ? '' : `warning: ${expectedWarning}\n`,
            );
          },
        );
      });

      describe('When pull fast-forwards onto a differently cased cone directory', () => {
        it(
          'Then case-pull leaves the same index tags and work tree as git',
          async () => {
            // Arrange
            const originRoot = mkdtempSync(
              join(os.tmpdir(), 'tsgit-interop-sequencer-sparse-origin-'),
            );
            extraDirs.push(originRoot);
            const originPath = join(originRoot, 'origin.git');
            runGit(['init', '-q', '--bare', '-b', 'main', originPath]);
            for (const dir of [pair.peer, pair.ours]) {
              seedTwin(dir, ignoreCase, CASE_SEED);
              enableSparse(dir, { cone: true });
            }
            runGit(['-C', pair.peer, 'push', '-q', originPath, 'refs/heads/other:refs/heads/main']);
            runGit(['-C', pair.peer, 'remote', 'add', 'origin', originPath]);
            runGit(['-C', pair.ours, 'remote', 'add', 'origin', ORIGIN_URL]);
            const warnings: string[] = [];
            const ctx = {
              ...createTrackedNodeContext({ workDir: pair.ours }),
              transport: backendTransport(originRoot),
              logger: { warn: (message: string) => warnings.push(message) },
            };

            // Act
            const git = gitExitOf(pair.peer, ['pull', '-q', 'origin', 'main']);
            const outcome = await outcomeOf(() => pull(ctx, { remote: 'origin', ref: 'main' }));

            // Assert
            expect(git.exitCode).toBe(0);
            expect(outcome).toEqual({ kind: 'ok' });
            expect(tagged(pair.ours)).toBe(tagged(pair.peer));
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
            expect(listing(pair.ours)).toEqual(expectedCaseListing(ignoreCase));
            expect(leftWarnings(warnings)).toEqual(leftWarning(git.stderr));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});
