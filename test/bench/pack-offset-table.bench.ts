/**
 * Bench: `buildOffsetTable`'s `.rev` accelerator — the O(n) gather from a
 * pack's reverse index versus the O(n log n) sort of `entryOffsets` it falls
 * back to. Two shapes, each run with the `.rev` present and with it deleted:
 * a single many-object pack (the shape the gather is expected to win on),
 * and many small packs (the shape where one extra `.rev` `open` + `read` per
 * pack can outweigh sorting each pack's own handful of offsets).
 *
 * Calls `RegisteredPack.offsetTable()` directly via `getPackRegistry` —
 * `buildOffsetTable` is the one and only subject here, so the bench never
 * routes through `readObject`'s pack-lookup scan, which would mix in cost
 * this measurement is not about.
 */
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { getPackRegistry } from '../../src/application/primitives/read-object.js';
import {
  MANY_OBJECT_COUNT,
  MANY_SMALL_PACK_COUNT,
  MANY_SMALL_PACK_OBJECTS_PER_PACK,
  type OffsetTablePackFixture,
  setupManyObjectPackFixture,
  setupManySmallPacksFixture,
} from './fixtures.js';
import type { BenchComparison } from './support/bench-dsl.js';
import { benchScenario } from './support/bench-dsl.js';
import { removeSync } from './support/fixture-scratch.js';

/**
 * Cold-open: a fresh `Context` per measured call, so `buildOffsetTable`'s
 * memo never carries over from one iteration to the next. Builds every
 * registered pack's offset table — one pack for the many-object fixture,
 * `MANY_SMALL_PACK_COUNT` for the many-small-packs fixture.
 */
const measureAllOffsetTables = async (cwd: string): Promise<void> => {
  const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });
  const packs = await getPackRegistry(ctx).all();
  for (const pack of packs) {
    await pack.offsetTable();
  }
};

const offsetTableComparison = (fixture: OffsetTablePackFixture): BenchComparison => {
  return {
    sut: () => measureAllOffsetTables(fixture.cwd),
    teardown: () => removeSync(fixture.cwd),
  };
};

benchScenario(
  `Given a many-object pack (${MANY_OBJECT_COUNT} objects) with a healthy .rev present`,
  'When buildOffsetTable() runs on every registered pack, Then measure tsgit',
  async () => offsetTableComparison(await setupManyObjectPackFixture(true)),
);

benchScenario(
  `Given the same many-object pack with its .rev deleted`,
  'When buildOffsetTable() runs on every registered pack, Then measure tsgit',
  async () => offsetTableComparison(await setupManyObjectPackFixture(false)),
);

benchScenario(
  `Given many small packs (${MANY_SMALL_PACK_COUNT} packs, ${MANY_SMALL_PACK_OBJECTS_PER_PACK} objects each) with a healthy .rev in every pack`,
  'When buildOffsetTable() runs on every registered pack, Then measure tsgit',
  async () => offsetTableComparison(await setupManySmallPacksFixture(true)),
);

benchScenario(
  'Given the same many-small-packs repository with every .rev deleted',
  'When buildOffsetTable() runs on every registered pack, Then measure tsgit',
  async () => offsetTableComparison(await setupManySmallPacksFixture(false)),
);
