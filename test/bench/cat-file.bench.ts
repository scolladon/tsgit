/**
 * Bench: `repo.catFile({ ids:[headCommitId] })` — the profiled `cat-file`
 * read workload, tsgit-only (no isomorphic-git analog in the suite). Loops
 * in place against the shared medium fixture, medium-only (not tiered).
 */
import { openRepository } from '../../src/index.node.js';
import { MEDIUM_FIXTURE } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const ctx = await resolveScaledContext(MEDIUM_FIXTURE);

scaledScenario(ctx, 'When catFile() reads the HEAD commit, Then measure tsgit', async (fixture) => {
  const repo = await openRepository({ cwd: fixture.cwd });

  const sut = async (): Promise<void> => {
    await repo.catFile({ ids: [fixture.headCommitId] });
  };
  return { teardown: () => repo.dispose(), sut };
});
