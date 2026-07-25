/**
 * Tiered bench: `repo.status()` scanning the clean working tree at each
 * fixture tier (small, medium — plus large under `TSGIT_BENCH_LARGE`).
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { MULTI_TIERS, tieredScenario } from './support/tiered-bench.js';

await tieredScenario(
  MULTI_TIERS,
  'When status() scans the clean tree, Then compare tsgit against isomorphic-git',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
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
