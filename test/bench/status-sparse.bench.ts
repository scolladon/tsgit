/**
 * Bench scenario: `status()` on sparse checkouts holding thousands of
 * skip-worktree entries — the cost of deciding, per entry, whether the file
 * is on disk. tsgit-only: there is no comparable baseline library.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { openRepository } from '../../src/index.node.js';
import { type SparseStatusLayout, setupSparseStatusFixture } from './fixtures.js';
import { benchScenario } from './support/bench-dsl.js';
import { removeSync } from './support/fixture-scratch.js';

// Lets the index's second pass so the warm call's refresh write is not racily clean.
const SETTLE_DELAY_MS = 1_100;

const sparseStatusScenario = (layout: SparseStatusLayout, given: string): void => {
  benchScenario(given, 'When status() scans it, Then measure tsgit alone', async () => {
    const fixture = await setupSparseStatusFixture(layout);
    const repo = await openRepository({ cwd: fixture.cwd });
    await sleep(SETTLE_DELAY_MS);
    await repo.status();

    let lastCall: Promise<unknown> = Promise.resolve();
    return {
      // A status() still in flight would recreate files under the directory
      // being removed, so it settles first; the removal itself stays sync
      // because tinybench does not await teardown.
      teardown: async (): Promise<void> => {
        await lastCall;
        removeSync(fixture.cwd);
        await repo.dispose();
      },
      sut: async (): Promise<void> => {
        lastCall = repo.status();
        await lastCall;
      },
    };
  });
};

sparseStatusScenario(
  'present-directories',
  'Given a sparse checkout of 20000 skip-worktree files whose directories are present',
);
sparseStatusScenario(
  'absent-directories',
  'Given a sparse checkout of 20000 skip-worktree files whose directories are removed',
);
