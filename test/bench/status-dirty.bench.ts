/**
 * Bench scenario: `status()` on a working tree with modified files — the
 * dirty counterpart to `status.bench.ts`'s clean-tree tiers. The cached tier
 * fixtures are read-only shared caches and cannot be dirtied, so this stays
 * on its own mutable small repo, out of the `status` registry op (its
 * basename is not a registry op).
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { setupDirtyWorkingTree, setupSmallRepo } from './fixtures.js';
import { benchScenario } from './support/bench-dsl.js';

benchScenario(
  'Given a 50-commit working tree with 25 modified files',
  'When status() scans it, Then compare tsgit against isomorphic-git',
  async () => {
    const fixture = await setupSmallRepo({ commits: 50 });
    await setupDirtyWorkingTree(fixture, 25);
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
      await fixture.cleanup();
    });

    const sut = async (): Promise<void> => {
      await repo.status();
    };
    return {
      sut,
      baseline: async (): Promise<void> => {
        await git.statusMatrix({ fs, dir: fixture.cwd });
      },
    };
  },
);
