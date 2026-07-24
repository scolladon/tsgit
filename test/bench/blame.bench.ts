/**
 * Tiered bench: `repo.blame()` on a file that is unchanged across a deep
 * ancestry (a sibling file churns every commit instead). Pins the
 * O(path-depth) descent + TREESAME skip win at each fixture tier — tsgit-only,
 * no isomorphic-git baseline (this measures tsgit-vs-tsgit across branches,
 * not vs isomorphic-git).
 */
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { DEEP_ANCESTRY_TIERS, tieredScenario } from './support/tiered-bench.js';

await tieredScenario(
  DEEP_ANCESTRY_TIERS,
  'When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });

    return {
      sut: async (): Promise<void> => {
        await repo.blame('stable.txt');
      },
    };
  },
);
