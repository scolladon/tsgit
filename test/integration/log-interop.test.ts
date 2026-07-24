/**
 * Cross-tool interop — converged `log`. Builds a diamond (merge of two branches,
 * strictly-increasing dates) plus an annotated tag via canonical `git`, then
 * opens the SAME repo through `openRepository` and proves `repo.log` projects
 * over the read model byte-for-byte against real `git`:
 *
 *   1. default order  — `repo.log()` oids === `git log --format=%H` (all parents,
 *      newest committer-date first — distinct from a first-parent walk);
 *   2. first-parent    — `repo.log({ order: 'first-parent' })` oids ===
 *      `git log --first-parent --format=%H`;
 *   3. annotated tag   — `repo.log({ rev: <tag> })` peels the tag to its commit,
 *      matching `git log --format=%H <tag>`;
 *   4. excluding range — `repo.log({ excluding: ['HEAD~2'] })` oids ===
 *      `git rev-list HEAD~2..HEAD` (a linear boundary where `until` ≡ git's `^`).
 *
 * Dates are strictly distinct and causally ordered, the regime where the lazy
 * `walkCommitsByDate` is byte-for-byte `--date-order` (ADR-261).
 *
 * @proves
 *   surface:        log
 *   bucket:         cross-tool-interop
 *   unique:         converged log order / first-parent / tag-peel / exclude vs git
 *   interopSurface: log
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import type { LogOptions } from '../../src/application/commands/log.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

interface Scenario {
  readonly dir: string;
  readonly tag: string;
  readonly dispose: () => Promise<void>;
}

const oidLines = (out: string): ReadonlyArray<string> =>
  out.split('\n').filter((line) => line.length > 0);

/**
 * base ← b (main) and base ← c (side), merge(b, c); annotated tag `v1` over b.
 * Also adds a second orphan root (root2) and merges it with --allow-unrelated-histories
 * so --max-parents=0 returns >1 root (non-trivial).
 */
const buildScenario = async (): Promise<Scenario> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-log-interop-')));
  runGit(['init', '-q', '-b', 'main', dir]);

  const commit = async (epoch: number, file: string, message: string): Promise<void> => {
    await writeFile(path.join(dir, file), `${file}\n`);
    git(dir, 'add', '.');
    runGit(['-C', dir, 'commit', '-q', '-m', message], { env: dateEnv(epoch) });
  };

  await commit(1700000001, 'base.txt', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  await commit(1700000002, 'b.txt', 'b on main');
  const b = git(dir, 'rev-parse', 'HEAD').trim();
  runGit(['-C', dir, 'tag', '-a', 'v1', '-m', 'tag b', b], { env: dateEnv(1700000002) });
  runGit(['-C', dir, 'checkout', '-q', '-b', 'side', base]);
  await commit(1700000003, 'c.txt', 'c on side');
  git(dir, 'checkout', '-q', 'main');
  runGit(['-C', dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
    env: dateEnv(1700000004),
  });

  // Second orphan root — makes --max-parents=0 return >1 root (non-trivial fixture)
  runGit(['-C', dir, 'checkout', '-q', '--orphan', 'root2']);
  runGit(['-C', dir, 'rm', '-q', '-rf', '.']);
  await commit(1700000005, 'root2.txt', 'root2');
  git(dir, 'checkout', '-q', 'main');
  runGit(
    [
      '-C',
      dir,
      'merge',
      '-q',
      '--no-ff',
      '--allow-unrelated-histories',
      '-m',
      'merge root2',
      'root2',
    ],
    {
      env: dateEnv(1700000006),
    },
  );

  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  return { dir, tag: 'v1', dispose };
};

const logIds = async (
  dir: string,
  opts?: Parameters<Awaited<ReturnType<typeof openRepository>>['log']>[0],
): Promise<ReadonlyArray<string>> => {
  const repo = await openRepository({ cwd: dir });
  try {
    return (await repo.log(opts)).map((entry) => entry.id);
  } finally {
    await repo.dispose();
  }
};

interface LogOidSequenceScenario {
  readonly label: string;
  // The consuming command varies per row (log vs rev-list, distinct flags);
  // same journey (tsgit oid sequence === real-git oid sequence), same oracle.
  readonly gitArgs: (scenario: Scenario) => ReadonlyArray<string>;
  readonly opts: (scenario: Scenario) => LogOptions;
}

const LOG_OID_SEQUENCE_MATRIX: ReadonlyArray<LogOidSequenceScenario> = [
  {
    label: 'the oid sequence equals git log (all parents, date order)',
    gitArgs: () => ['log', '--format=%H'],
    opts: () => ({}),
  },
  {
    label: "the oid sequence equals git log --first-parent (order: 'first-parent')",
    gitArgs: () => ['log', '--first-parent', '--format=%H'],
    opts: () => ({ order: 'first-parent' }),
  },
  {
    label: 'it peels the tag and matches git log <tag>',
    gitArgs: (scenario) => ['log', '--format=%H', scenario.tag],
    opts: (scenario) => ({ rev: scenario.tag }),
  },
  {
    // HEAD~3 is `b on main`; excluding it leaves the top 3 commits.
    label: 'it matches git rev-list HEAD~3..HEAD (excluding a grammar selector)',
    gitArgs: () => ['rev-list', 'HEAD~3..HEAD'],
    opts: () => ({ excluding: ['HEAD~3'] }),
  },
  {
    // scenario has two roots (base and root2); non-trivial set
    label: 'the oid sequence equals git rev-list --max-parents=0',
    gitArgs: () => ['rev-list', '--max-parents=0', 'HEAD'],
    opts: () => ({ maxParents: 0 }),
  },
  {
    // merges only
    label: 'the oid sequence equals git rev-list --min-parents=2',
    gitArgs: () => ['rev-list', '--min-parents=2', 'HEAD'],
    opts: () => ({ minParents: 2 }),
  },
  {
    // non-merges only
    label: 'the oid sequence equals git rev-list --max-parents=1',
    gitArgs: () => ['rev-list', '--max-parents=1', 'HEAD'],
    opts: () => ({ maxParents: 1 }),
  },
  {
    // non-roots only
    label: 'the oid sequence equals git rev-list --min-parents=1',
    gitArgs: () => ['rev-list', '--min-parents=1', 'HEAD'],
    opts: () => ({ minParents: 1 }),
  },
  {
    // filter applied before limit: newest non-merge commit — proves filter
    // precedes limit; result is a non-merge, not a merge
    label: 'the first result equals git rev-list --max-parents=1 -n 1 (filter-then-limit)',
    gitArgs: () => ['rev-list', '--max-parents=1', '-n', '1', 'HEAD'],
    opts: () => ({ maxParents: 1, limit: 1 }),
  },
  {
    // first-parent walk; merge commits still count >=2 parents even though
    // only first parent is followed during traversal
    label:
      "the oid sequence equals git rev-list --first-parent --min-parents=2 (order: 'first-parent')",
    gitArgs: () => ['rev-list', '--first-parent', '--min-parents=2', 'HEAD'],
    opts: () => ({ order: 'first-parent', minParents: 2 }),
  },
];

describe.skipIf(!GIT_AVAILABLE)('log interop', () => {
  describe('Given a diamond with a merge and an annotated tag', () => {
    describe('When log or rev-list runs with each oid-sequence variant', () => {
      it.each(LOG_OID_SEQUENCE_MATRIX)('Then $label', async ({ gitArgs, opts }) => {
        // Arrange
        const scenario = await buildScenario();
        try {
          const peer = oidLines(git(scenario.dir, ...gitArgs(scenario)));

          // Act
          const ours = await logIds(scenario.dir, opts(scenario));

          // Assert
          expect(ours).toEqual(peer);
        } finally {
          await scenario.dispose();
        }
      });
    });
  });
});
