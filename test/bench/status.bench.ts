/**
 * Tiered bench: `repo.status()` scanning the clean working tree at each
 * fixture tier (small, medium — plus large under `TSGIT_BENCH_LARGE`), in two
 * shapes. `status` writes the refreshed index back, so each tier runs on a
 * disposable copy of the cached fixture.
 *
 * - settled: the refresh write already happened, every entry is stat-valid.
 * - stat-invalid: `refresh: false` keeps the copied tree stat-invalid on
 *   every call — the shape of a freshly restored CI checkout.
 */
import * as fs from 'node:fs';
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import * as git from 'isomorphic-git';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import type { BenchComparison } from './support/bench-dsl.js';
import type { ScaledFixture } from './support/fixture-generator.js';
import { copyFixtureToScratch } from './support/fixture-scratch.js';
import { MULTI_TIERS, tieredScenario } from './support/tiered-bench.js';

// The copy's mtimes must leave the index's second, or the refresh write is
// skipped as racily clean.
const SETTLE_DELAY_MS = 1_100;

const indexInode = (cwd: string): number => statSync(path.join(cwd, '.git', 'index')).ino;

const assertIndexUntouched = async (
  cwd: string,
  scenario: string,
  run: () => Promise<unknown>,
): Promise<void> => {
  const before = indexInode(cwd);
  await run();
  if (indexInode(cwd) !== before) throw new Error(`${scenario}: status rewrote the index`);
};

const buildTierScenario = async (
  fixture: ScaledFixture,
  scenario: string,
  prepare: (repo: Repository) => Promise<void>,
  measured: (repo: Repository) => Promise<unknown>,
): Promise<BenchComparison> => {
  const scratch = await copyFixtureToScratch(fixture.cwd);
  const repo = await openRepository({ cwd: scratch.cwd });
  await prepare(repo);
  await assertIndexUntouched(scratch.cwd, scenario, () => measured(repo));
  return {
    teardown: async (): Promise<void> => {
      scratch.disposeSync();
      await repo.dispose();
    },
    sut: async (): Promise<void> => {
      await measured(repo);
    },
    baseline: async (): Promise<void> => {
      await git.statusMatrix({ fs, dir: scratch.cwd });
    },
  };
};

await tieredScenario(
  MULTI_TIERS,
  'When status() scans the settled clean tree, Then compare tsgit against isomorphic-git',
  (fixture) =>
    buildTierScenario(
      fixture,
      'settled',
      async (repo) => {
        await sleep(SETTLE_DELAY_MS);
        await repo.status();
      },
      (repo) => repo.status(),
    ),
);

await tieredScenario(
  MULTI_TIERS,
  'When status() scans the stat-invalid clean tree without refresh, Then compare tsgit against isomorphic-git',
  (fixture) =>
    buildTierScenario(
      fixture,
      'stat-invalid',
      async () => {},
      (repo) => repo.status({ refresh: false }),
    ),
);
