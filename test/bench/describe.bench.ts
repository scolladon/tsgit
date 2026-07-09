/**
 * Scaled bench: `repo.describe()` on a deep history with an annotated tag ten
 * commits below HEAD — pins the early-termination win (O(distance) traversal
 * instead of O(history)). tsgit-only: isomorphic-git has no describe.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const execFileAsync = promisify(execFile);

const NEAR_TAG = 'bench-describe-near';
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
  'When describe() resolves a near tag, Then the walk stops at the covered path',
  async (fixture) => {
    await ensureNearTag(fixture.cwd);
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });
    return {
      sut: async (): Promise<void> => {
        await repo.describe();
      },
    };
  },
);
