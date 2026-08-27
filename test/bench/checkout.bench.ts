/**
 * Tiered bench: `checkout()` alternating between the fixture's tip and its
 * root commit at each fixture tier (small, medium — plus large under
 * `TSGIT_BENCH_LARGE`). Every `multi`-strategy fixture commit adds disjoint
 * paths and never rewrites one, so a tip↔root round trip materialises (or
 * removes) nearly every tracked file — the parallel-write workload the
 * bounded checkout waves are sized for.
 */
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { MULTI_TIERS, tieredScenario } from './support/tiered-bench.js';

await tieredScenario(
  MULTI_TIERS,
  'When checkout() alternates tip and root, Then measure tsgit',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });

    const history = await repo.log({ order: 'first-parent' });
    const rootCommitId = history.at(-1)?.id ?? fixture.headCommitId;
    let atTip = true;

    const sut = async (): Promise<void> => {
      const rev = atTip ? rootCommitId : fixture.headCommitId;
      atTip = !atTip;
      await repo.checkout({ rev, force: true });
    };
    return { sut };
  },
);
