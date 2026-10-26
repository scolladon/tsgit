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
 * The tiered `multi` fixtures never reach a genuinely MIXED changeset (every
 * commit only ADDS disjoint paths); the scratch scenarios at the end of the
 * file price directional root→tip, tip→root and root→mixed (add, update and
 * delete together) checkouts on a 500-directory repo built by `write-scratch`.
 *
 * Each tier runs on a disposable copy of the cached fixture: `checkout`
 * moves `HEAD`, rewrites the index and rewrites the working tree, and the
 * cache is reused byte-for-byte by every other bench file resolving the
 * same spec — mutating it in place here would corrupt every later reader.
 */

import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import { benchScenario } from './support/bench-dsl.js';
import type { ScaledFixture } from './support/fixture-generator.js';
import { copyFixtureToScratch, type FixtureScratch } from './support/fixture-scratch.js';
import { MULTI_TIERS, tieredScenario } from './support/tiered-bench.js';
import { buildCheckoutScratch, type ScratchRepo } from './support/write-scratch.js';

interface OpenedCopy {
  readonly repo: Repository;
  readonly scratch: FixtureScratch;
}

/** Copies the fixture and opens the copy; a failed open disposes the copy so nothing leaks. */
const openFixtureCopy = async (fixture: ScaledFixture): Promise<OpenedCopy> => {
  const scratch = await copyFixtureToScratch(fixture.cwd);
  try {
    return { repo: await openRepository({ cwd: scratch.cwd }), scratch };
  } catch (err) {
    await scratch.dispose();
    throw err;
  }
};

await tieredScenario(
  MULTI_TIERS,
  'When checkout() alternates tip and root with force, Then measure tsgit',
  async (fixture) => {
    const { repo, scratch } = await openFixtureCopy(fixture);
    // The copy is removed synchronously so the un-awaited teardown still
    // completes; the handle close may float — the process exit closes it too.
    const teardown = async (): Promise<void> => {
      scratch.disposeSync();
      await repo.dispose();
    };

    const history = await repo.log({ order: 'first-parent' });
    const rootCommitId = history.at(-1)?.id ?? fixture.headCommitId;
    let atTip = true;

    const sut = async (): Promise<void> => {
      const rev = atTip ? rootCommitId : fixture.headCommitId;
      atTip = !atTip;
      await repo.checkout({ rev, force: true });
    };
    return { sut, teardown };
  },
);

await tieredScenario(
  MULTI_TIERS,
  'When checkout() alternates tip and root without force, Then measure tsgit',
  async (fixture) => {
    const { repo, scratch } = await openFixtureCopy(fixture);
    // The copy is removed synchronously so the un-awaited teardown still
    // completes; the handle close may float — the process exit closes it too.
    const teardown = async (): Promise<void> => {
      scratch.disposeSync();
      await repo.dispose();
    };

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
    return { sut, teardown };
  },
);

await tieredScenario(
  MULTI_TIERS,
  'When checkout() forces HEAD on a clean tree, Then measure tsgit',
  async (fixture) => {
    const { repo, scratch } = await openFixtureCopy(fixture);
    const teardown = async (): Promise<void> => {
      scratch.disposeSync();
      await repo.dispose();
    };
    const sut = async (): Promise<void> => {
      await repo.checkout({ rev: 'HEAD', force: true });
    };
    return { sut, teardown };
  },
);

await tieredScenario(
  MULTI_TIERS,
  'When reset() hard-resets HEAD on a clean tree, Then measure tsgit',
  async (fixture) => {
    const { repo, scratch } = await openFixtureCopy(fixture);
    const teardown = async (): Promise<void> => {
      scratch.disposeSync();
      await repo.dispose();
    };
    const sut = async (): Promise<void> => {
      await repo.reset({ mode: 'hard', rev: 'HEAD' });
    };
    return { sut, teardown };
  },
);

const POOL_SIZE = 12;
const FIXED_ITERATIONS = { warmup: 2, measured: 10 } as const;

interface CheckoutPool {
  readonly next: () => Repository;
  readonly teardown: () => void;
}

const openPoolCopy = async (source: ScratchRepo): Promise<OpenedCopy> => {
  const scratch = await copyFixtureToScratch(source.cwd);
  return { repo: await openRepository({ cwd: scratch.cwd }), scratch };
};

/** Builds the source at `startRev`, then `POOL_SIZE` opened copies of it: each checkout call burns one. */
const buildCheckoutPool = async (startRev: string): Promise<CheckoutPool> => {
  const source = await buildCheckoutScratch();
  if (startRev !== 'root') await source.repo.checkout({ rev: startRev, force: true });
  const copies: OpenedCopy[] = [];
  for (let i = 0; i < POOL_SIZE; i += 1) copies.push(await openPoolCopy(source));
  let cursor = 0;
  let released = false;
  // Consumed copies stay listed so teardown releases them too.
  const teardown = (): void => {
    if (released) return;
    released = true;
    for (const copy of copies) copy.scratch.disposeSync();
    source.disposeSync();
  };
  return {
    next: (): Repository => {
      const copy = copies[cursor];
      if (copy === undefined) throw new Error('checkout pool exhausted');
      cursor += 1;
      return copy.repo;
    },
    teardown,
  };
};

const checkoutScenario = (given: string, whenThen: string, startRev: string, rev: string): void => {
  benchScenario(
    given,
    whenThen,
    async () => {
      const pool = await buildCheckoutPool(startRev);
      return {
        teardown: pool.teardown,
        sut: async (): Promise<void> => {
          await pool.next().checkout({ rev, force: true });
        },
      };
    },
    { fixedIterations: FIXED_ITERATIONS },
  );
};

checkoutScenario(
  'Given a 500-directory scratch repo at its root commit',
  'When checkout() moves to the tip with force, Then measure tsgit',
  'root',
  'tip',
);
checkoutScenario(
  'Given a 500-directory scratch repo at its tip commit',
  'When checkout() moves to the root with force, Then measure tsgit',
  'tip',
  'root',
);
checkoutScenario(
  'Given a 500-directory scratch repo whose mixed branch adds, updates and deletes files',
  'When checkout() moves from root to mixed with force, Then measure tsgit',
  'root',
  'mixed',
);
