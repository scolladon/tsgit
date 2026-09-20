/**
 * Bench: `repo.revParse('HEAD')` — the profiled `rev-parse` read workload,
 * tsgit-only (no isomorphic-git analog in the suite). Loops in place against
 * the shared medium fixture, medium-only (not tiered). A second row resolves
 * a 7-hex abbreviated oid, exercising the fanout/prefix-scan sweep instead of
 * the symbolic-ref fast path `HEAD` takes.
 */
import { openRepository } from '../../src/index.node.js';
import { MEDIUM_FIXTURE } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const ABBREVIATED_OID_LENGTH = 7;

const ctx = await resolveScaledContext(MEDIUM_FIXTURE);

scaledScenario(ctx, 'When revParse() resolves HEAD, Then measure tsgit', async (fixture) => {
  const repo = await openRepository({ cwd: fixture.cwd });

  const sut = async (): Promise<void> => {
    await repo.revParse('HEAD');
  };
  return { teardown: () => repo.dispose(), sut };
});

scaledScenario(
  ctx,
  'When revParse() resolves an abbreviated oid, Then measure tsgit',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    const abbreviatedOid = fixture.headCommitId.slice(0, ABBREVIATED_OID_LENGTH);

    const sut = async (): Promise<void> => {
      await repo.revParse(abbreviatedOid);
    };
    return { teardown: () => repo.dispose(), sut };
  },
);
