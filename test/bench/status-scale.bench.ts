/**
 * Scaled bench: `repo.status()` on the clean working tree of the medium
 * fixture (20k files — or the large 200k fixture under `TSGIT_BENCH_LARGE`).
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const ctx = await resolveScaledContext();

scaledScenario(
  ctx,
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
