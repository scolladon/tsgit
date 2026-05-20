/**
 * Bench scenario: `status` on a clean working tree, and on a working tree with
 * 25 modified files. tsgit's stat-cache should make the clean case roughly
 * O(index entries); isomorphic-git's `statusMatrix` builds a per-file walk.
 *
 * Each scenario builds + owns its own fixture so the dirty scenario can never
 * bleed mutations into the clean one.
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { setupDirtyWorkingTree, setupSmallRepo } from './fixtures.js';
import { benchScenario } from './support/bench-dsl.js';

benchScenario(
  'Given a clean 50-commit working tree',
  'When status() scans it, Then compare tsgit against isomorphic-git',
  async () => {
    const fixture = await setupSmallRepo({ commits: 50 });
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
