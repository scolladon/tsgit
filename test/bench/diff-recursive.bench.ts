/**
 * Bench: `repo.diff({ from:'HEAD~1', to:'HEAD', recursive:true })` — the
 * recursive/megarepo tree-diff hot loop, tsgit-only (no isomorphic-git
 * recursive-diff analog in the suite).
 */
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { MEDIUM_FIXTURE } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const ctx = await resolveScaledContext(MEDIUM_FIXTURE);

scaledScenario(
  ctx,
  'When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });

    const sut = async (): Promise<void> => {
      await repo.diff({ from: 'HEAD~1', to: 'HEAD', recursive: true });
    };
    return { sut };
  },
);
