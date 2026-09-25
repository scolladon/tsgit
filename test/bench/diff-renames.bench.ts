/**
 * Bench: `repo.diff({ from:'HEAD~1', to:'HEAD', recursive:true,
 * detectRenames:true })` over three shapes, loose and packed:
 *  - `common`: 50 files, 3 renamed and edited — the everyday `show`/`log -M`
 *    diff, priced to watch the size-gate's overhead on a diff too small to
 *    ever need it.
 *  - `wide`: 300 files, every one moved and edited — scales the rename
 *    matrix without stressing the hydration gate (every pair is a regular
 *    small file).
 *  - `hostile`: 300 distinct 1 MiB deletes against one 6-byte add — the
 *    worst case the hydration gate exists for: every delete must be dropped
 *    on size alone, never read in full to be scored against the tiny add.
 */
import { openRepository } from '../../src/index.node.js';
import { type BenchComparison, benchScenario } from './support/bench-dsl.js';
import {
  ensureRenameFixture,
  isFixtureUnavailable,
  type RenameFixture,
  type RenameFixtureShape,
  type RenameFixtureStorage,
} from './support/fixture-generator.js';

interface RenameFixtureContext {
  readonly fixture?: RenameFixture;
  readonly given: string;
}

const SHAPE_GIVEN: Record<RenameFixtureShape, string> = {
  common: 'Given a common repo (50 files, 3 renamed and edited)',
  wide: 'Given a wide repo (300 files, every one moved and edited)',
  hostile: 'Given a hostile repo (300 distinct 1 MiB deletes, one 6-byte add)',
};

const STORAGE_GIVEN: Record<RenameFixtureStorage, string> = {
  loose: 'loose (as committed)',
  packed: 'packed via `git repack -ad`',
};

/** Resolves one shape/storage fixture, skipping cleanly (never failing the bench
 *  file) when `git` is unavailable or a Stryker sandbox short-circuits it. */
const resolveRenameContext = async (
  shape: RenameFixtureShape,
  storage: RenameFixtureStorage,
): Promise<RenameFixtureContext> => {
  const given = `${SHAPE_GIVEN[shape]}, ${STORAGE_GIVEN[storage]}`;
  if (process.env.STRYKER_MUTANT_ID !== undefined) return { given };
  try {
    const fixture = await ensureRenameFixture(shape, storage);
    return { fixture, given };
  } catch (err) {
    if (isFixtureUnavailable(err)) return { given };
    throw err;
  }
};

const buildRenameComparison = async (fixture: RenameFixture): Promise<BenchComparison> => {
  const repo = await openRepository({ cwd: fixture.cwd });

  const sut = async (): Promise<void> => {
    await repo.diff({ from: 'HEAD~1', to: 'HEAD', recursive: true, detectRenames: true });
  };
  return { teardown: () => repo.dispose(), sut };
};

const WHEN_THEN =
  'When diff() compares HEAD~1 against HEAD recursively with detectRenames:true, Then measure tsgit';

const registerRenameScenario = (ctx: RenameFixtureContext): void => {
  const { fixture } = ctx;
  benchScenario(
    ctx.given,
    WHEN_THEN,
    () => {
      // Guaranteed present here: `skip` below is true exactly when it is undefined.
      if (fixture === undefined) throw new Error('rename fixture unavailable');
      return buildRenameComparison(fixture);
    },
    { skip: fixture === undefined },
  );
};

const SHAPES: ReadonlyArray<RenameFixtureShape> = ['common', 'wide', 'hostile'];
const STORAGES: ReadonlyArray<RenameFixtureStorage> = ['loose', 'packed'];

for (const shape of SHAPES) {
  for (const storage of STORAGES) {
    registerRenameScenario(await resolveRenameContext(shape, storage));
  }
}
