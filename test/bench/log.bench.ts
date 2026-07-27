/**
 * Tiered bench: `repo.log()` walking every commit at each fixture tier
 * (small, medium — plus large under `TSGIT_BENCH_LARGE`). Also benches the
 * commit-graph read path: the same walk against a fixture carrying a written
 * commit-graph, tsgit-only (no isomorphic-git commit-graph support), compared
 * against the object-read walk above.
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { MEDIUM_FIXTURE_WITH_COMMIT_GRAPH } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';
import { MULTI_TIERS, tieredScenario } from './support/tiered-bench.js';

await tieredScenario(
  MULTI_TIERS,
  'When log() walks every commit, Then compare tsgit against isomorphic-git',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });

    const sut = async (): Promise<void> => {
      await repo.log();
    };
    return {
      sut,
      baseline: async (): Promise<void> => {
        await git.log({ fs, dir: fixture.cwd, depth: fixture.spec.commits });
      },
    };
  },
);

const graphCtx = await resolveScaledContext(MEDIUM_FIXTURE_WITH_COMMIT_GRAPH);

scaledScenario(
  graphCtx,
  'When log() walks every commit via a written commit-graph, Then measure tsgit',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });

    const sut = async (): Promise<void> => {
      await repo.log();
    };
    return { sut };
  },
);
