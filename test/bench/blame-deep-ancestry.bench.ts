/**
 * Bench scenario: `repo.blame()` on a file that is unchanged across a deep
 * ancestry (a sibling file churns every commit instead). Pins the O(path-depth)
 * descent + TREESAME skip win — tsgit-only, no isomorphic-git baseline (this
 * measures tsgit-vs-tsgit across branches, not vs isomorphic-git).
 */
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { setupDeepAncestryRepo } from './fixtures.js';
import { benchScenario } from './support/bench-dsl.js';

const COMMITS = 200;

benchScenario(
  `Given a ${COMMITS}-commit deep ancestry where stable.txt never changes`,
  'When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree',
  async () => {
    const fixture = await setupDeepAncestryRepo({ commits: COMMITS });
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
      await fixture.cleanup();
    });

    const sut = async (): Promise<void> => {
      await repo.blame('stable.txt');
    };
    return { sut };
  },
);
