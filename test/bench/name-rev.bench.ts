/**
 * Scaled bench: `repo.nameRev()` on a deep history with an annotated tag ten
 * commits below HEAD — pins the date-cutoff pruning win (O(distance) reads
 * instead of walking the full history per ref). tsgit-only: isomorphic-git
 * has no name-rev.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const execFileAsync = promisify(execFile);

const NEAR_TAG = 'bench-name-rev-near';
const TAG_DISTANCE = 10;

const ensureNearTag = async (cwd: string): Promise<void> => {
  const scrubbed = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  await execFileAsync(
    'git',
    ['-C', cwd, 'tag', '-f', '-a', NEAR_TAG, '-m', NEAR_TAG, `HEAD~${TAG_DISTANCE}`],
    {
      env: {
        ...scrubbed,
        GIT_AUTHOR_NAME: 'bench',
        GIT_AUTHOR_EMAIL: 'bench@tsgit.invalid',
        GIT_COMMITTER_NAME: 'bench',
        GIT_COMMITTER_EMAIL: 'bench@tsgit.invalid',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    },
  );
};

const ctx = await resolveScaledContext();

scaledScenario(
  ctx,
  'When name-rev() names a near-tip commit, Then the walk stops at the date cutoff',
  async (fixture) => {
    await ensureNearTag(fixture.cwd);
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });
    return {
      sut: async (): Promise<void> => {
        await repo.nameRev('HEAD~2');
      },
    };
  },
);
