/**
 * Tiered bench: `checkout()` alternating between the fixture's tip and its
 * root commit at each fixture tier (small, medium — plus large under
 * `TSGIT_BENCH_LARGE`). Every `multi`-strategy fixture commit adds disjoint
 * paths and never rewrites one, so a tip↔root round trip materialises (or
 * removes) nearly every tracked file — the parallel-write workload the
 * bounded checkout waves are sized for.
 *
 * Two variants run: `force: true` (the write waves only — `checkDirty`'s
 * parallelised probe pool never runs) and `force: false` (the same
 * alternation, but each checkout starts from the clean tree the PRIOR
 * checkout just produced, so `checkDirty` runs and finds nothing dirty —
 * priced as pure overhead on top of the write waves).
 *
 * `multi`-strategy fixtures never reach a genuinely MIXED changeset (add
 * and delete together in one call): every commit only ADDS disjoint paths,
 * so a root→tip checkout is all-add and tip→root is all-delete, whichever
 * two ancestor-related commits are chosen. Pricing a real mixed wave needs
 * a fixture strategy that also removes/rewrites paths across history —
 * tracked as a fixture-generator follow-up, not faked here with a strategy
 * that cannot produce it.
 */
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { MULTI_TIERS, tieredScenario } from './support/tiered-bench.js';

await tieredScenario(
  MULTI_TIERS,
  'When checkout() alternates tip and root with force, Then measure tsgit',
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

await tieredScenario(
  MULTI_TIERS,
  'When checkout() alternates tip and root without force, Then measure tsgit',
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
      // No force: every prior checkout in this alternation left the tree
      // exactly at its target, so `checkDirty`'s probe pool always finds a
      // clean tree — this measures its overhead, never a refusal.
      await repo.checkout({ rev, force: false });
    };
    return { sut };
  },
);
