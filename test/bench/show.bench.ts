/**
 * Bench: `repo.show('HEAD')` — the profiled `show` read workload, tsgit-only
 * (no isomorphic-git analog in the suite). Loops in place against the shared
 * medium fixture, medium-only (not tiered).
 */
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { MEDIUM_FIXTURE } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const ctx = await resolveScaledContext(MEDIUM_FIXTURE);

scaledScenario(ctx, 'When show() resolves HEAD, Then measure tsgit', async (fixture) => {
  const repo = await openRepository({ cwd: fixture.cwd });
  afterAll(async () => {
    await repo.dispose();
  });

  const sut = async (): Promise<void> => {
    await repo.show('HEAD');
  };
  return { sut };
});
