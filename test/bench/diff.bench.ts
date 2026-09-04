/**
 * Bench: `repo.diff({ from:'HEAD~1', to:'HEAD' })` — the profiled `diff` read
 * workload, tsgit-only (no isomorphic-git analog in the suite). Loops in
 * place against the shared medium fixture, medium-only (not tiered).
 */
import { openRepository } from '../../src/index.node.js';
import { MEDIUM_FIXTURE } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const ctx = await resolveScaledContext(MEDIUM_FIXTURE);

scaledScenario(
  ctx,
  'When diff() compares HEAD~1 against HEAD, Then measure tsgit',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });

    const sut = async (): Promise<void> => {
      await repo.diff({ from: 'HEAD~1', to: 'HEAD' });
    };
    return { teardown: () => repo.dispose(), sut };
  },
);
