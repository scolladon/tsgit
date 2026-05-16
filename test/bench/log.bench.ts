/**
 * Bench scenario: walk N commits from HEAD via `repo.log()` versus
 * `isomorphic-git.log()`. Both libraries see the same on-disk repo.
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll, bench, describe } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { type BenchRepo, setupSmallRepo } from './fixtures.js';

const COMMITS = 50;
let fixture: BenchRepo;
let repo: Awaited<ReturnType<typeof openRepository>>;

describe('log:walk-50-commits', async () => {
  fixture = await setupSmallRepo({ commits: COMMITS });
  repo = await openRepository({ cwd: fixture.cwd });

  bench('tsgit', async () => {
    await repo.log();
  });

  bench('isomorphic-git', async () => {
    await git.log({ fs, dir: fixture.cwd, depth: COMMITS });
  });

  afterAll(async () => {
    await repo.dispose();
    await fixture.cleanup();
  });
});
