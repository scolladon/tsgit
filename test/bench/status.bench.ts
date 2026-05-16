/**
 * Bench scenario: `status` on a clean working tree, and on a working tree with
 * 25 modified files. tsgit's stat-cache should make the clean case roughly
 * O(index entries); isomorphic-git's `statusMatrix` builds a per-file walk.
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll, bench, describe } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { setupDirtyWorkingTree, setupSmallRepo } from './fixtures.js';

// Each describe block builds + owns its own fixture so the dirty scenario can
// never bleed mutations into the clean one. Cleanup runs unconditionally via
// afterAll on each block.
describe('status:clean', async () => {
  const fixture = await setupSmallRepo({ commits: 50 });
  const repo = await openRepository({ cwd: fixture.cwd });

  bench('tsgit', async () => {
    await repo.status();
  });

  bench('isomorphic-git', async () => {
    await git.statusMatrix({ fs, dir: fixture.cwd });
  });

  afterAll(async () => {
    await repo.dispose();
    await fixture.cleanup();
  });
});

describe('status:dirty-25-files', async () => {
  const fixture = await setupSmallRepo({ commits: 50 });
  await setupDirtyWorkingTree(fixture, 25);
  const repo = await openRepository({ cwd: fixture.cwd });

  bench('tsgit', async () => {
    await repo.status();
  });

  bench('isomorphic-git', async () => {
    await git.statusMatrix({ fs, dir: fixture.cwd });
  });

  afterAll(async () => {
    await repo.dispose();
    await fixture.cleanup();
  });
});
