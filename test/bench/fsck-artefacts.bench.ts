/**
 * Bench: `fsck`'s added hashing cost when a pack carries a `.rev` and a
 * `.bitmap` alongside its `.idx`. `runRevIndexHealthPass` hashes the whole
 * `.rev` body and walks every position against the pack's own index;
 * `runBitmapHealthPass` hashes the whole `.bitmap` body. Both run
 * unconditionally whenever the sibling exists — there is no fsck flag that
 * skips them — so git pays the identical cost for the identical shape;
 * this bench prices the delta, not a tsgit-specific overhead.
 */
import { openRepository } from '../../src/index.node.js';
import { MANY_OBJECT_COUNT, setupFsckArtefactFixture } from './fixtures.js';
import type { BenchComparison } from './support/bench-dsl.js';
import { benchScenario } from './support/bench-dsl.js';
import { removeSync } from './support/fixture-scratch.js';

const fsckComparison = (withArtefacts: boolean) => async (): Promise<BenchComparison> => {
  const fixture = await setupFsckArtefactFixture(withArtefacts);
  const repo = await openRepository({ cwd: fixture.cwd });

  return {
    teardown: async (): Promise<void> => {
      removeSync(fixture.cwd);
      await repo.dispose();
    },
    sut: async (): Promise<void> => {
      await repo.fsck();
    },
  };
};

benchScenario(
  `Given a many-object pack (${MANY_OBJECT_COUNT} objects) with no .rev and no .bitmap`,
  'When fsck() audits the repository, Then measure tsgit',
  fsckComparison(false),
);

benchScenario(
  'Given the same many-object pack carrying a healthy .rev and .bitmap',
  'When fsck() audits the repository, Then measure tsgit',
  fsckComparison(true),
);
