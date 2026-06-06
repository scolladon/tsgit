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

/** base ← b (main) and base ← c (side), merge(b, c); annotated tag `v1` over b. */
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

describe.skipIf(!GIT_AVAILABLE)('log interop', () => {
  describe('Given a diamond with a merge and an annotated tag', () => {
    describe('When log runs with the default order', () => {
      it('Then the oid sequence equals git log (all parents, date order)', async () => {
        // Arrange
        const scenario = await buildScenario();
        try {
          const peer = oidLines(git(scenario.dir, 'log', '--format=%H'));

          // Act
          const ours = await logIds(scenario.dir);

          // Assert
          expect(ours).toEqual(peer);
        } finally {
          await scenario.dispose();
        }
      });
    });

    describe("When log runs with order 'first-parent'", () => {
      it('Then the oid sequence equals git log --first-parent', async () => {
        // Arrange
        const scenario = await buildScenario();
        try {
          const peer = oidLines(git(scenario.dir, 'log', '--first-parent', '--format=%H'));

          // Act
          const ours = await logIds(scenario.dir, { order: 'first-parent' });

          // Assert
          expect(ours).toEqual(peer);
        } finally {
          await scenario.dispose();
        }
      });
    });

    describe('When log runs from an annotated tag', () => {
      it('Then it peels the tag and matches git log <tag>', async () => {
        // Arrange
        const scenario = await buildScenario();
        try {
          const peer = oidLines(git(scenario.dir, 'log', '--format=%H', scenario.tag));

          // Act
          const ours = await logIds(scenario.dir, { rev: scenario.tag });

          // Assert
          expect(ours).toEqual(peer);
        } finally {
          await scenario.dispose();
        }
      });
    });

    describe('When log excludes a grammar selector', () => {
      it('Then it matches git rev-list HEAD~2..HEAD', async () => {
        // Arrange — HEAD~2 is the root `base`; excluding it leaves {merge, c, b}.
        const scenario = await buildScenario();
        try {
          const peer = oidLines(git(scenario.dir, 'rev-list', 'HEAD~2..HEAD'));

          // Act
          const ours = await logIds(scenario.dir, { excluding: ['HEAD~2'] });

          // Assert
          expect(ours).toEqual(peer);
        } finally {
          await scenario.dispose();
        }
      });
    });
  });
});
