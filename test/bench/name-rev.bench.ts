/**
 * Scaled bench: `repo.nameRev()` naming a tagged commit dated more than one
 * day after the deep fixture history — pins the date-cutoff pruning win
 * (O(distance) reads instead of walking the full history per ref; the
 * fixture's commits are seconds apart, so only a >1-day-newer target makes
 * the cutoff fire). tsgit-only: isomorphic-git has no name-rev.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const execFileAsync = promisify(execFile);

const NEAR_TAG = 'bench-name-rev-near';
const DAY_AND_A_BIT = 90_000;

const benchEnv = (): NodeJS.ProcessEnv => {
  const scrubbed = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return {
    ...scrubbed,
    GIT_AUTHOR_NAME: 'bench',
    GIT_AUTHOR_EMAIL: 'bench@tsgit.invalid',
    GIT_COMMITTER_NAME: 'bench',
    GIT_COMMITTER_EMAIL: 'bench@tsgit.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
  };
};

const gitOut = async (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { env });
  return stdout.trim();
};

/**
 * Anchors an annotated tag on a deterministic dangling commit dated a
 * day-and-a-bit past the fixture tip, WITHOUT moving any fixture branch (the
 * fixture is cache-keyed and shared across bench files). Naming this commit
 * puts every fixture commit below the cutoff, so the walk prunes instead of
 * flooding. `commit-tree` with pinned dates yields the same oid every run —
 * idempotent, no fixture growth.
 */
const ensurePrunableTaggedTip = async (cwd: string): Promise<string> => {
  const env = benchEnv();
  const tipDate = Number(await gitOut(cwd, ['log', '-1', '--format=%ct'], env));
  const tree = await gitOut(cwd, ['log', '-1', '--format=%T'], env);
  const parent = await gitOut(cwd, ['rev-parse', 'HEAD'], env);
  const date = `${tipDate + DAY_AND_A_BIT} +0000`;
  const datedEnv = { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const target = await gitOut(cwd, ['commit-tree', tree, '-p', parent, '-m', NEAR_TAG], datedEnv);
  await execFileAsync('git', ['-C', cwd, 'tag', '-f', '-a', NEAR_TAG, '-m', NEAR_TAG, target], {
    env: datedEnv,
  });
  return target;
};

const ctx = await resolveScaledContext();

scaledScenario(
  ctx,
  'When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff',
  async (fixture) => {
    const target = await ensurePrunableTaggedTip(fixture.cwd);
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });
    return {
      sut: async (): Promise<void> => {
        await repo.nameRev(target);
      },
    };
  },
);
