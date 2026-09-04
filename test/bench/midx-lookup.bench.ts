/**
 * Bench: `readBlob()` lookup cost as a function of pack count, pinning §D7's
 * claim — a midx collapses P per-pack fanout searches into one — and the
 * regression guard that the midx machinery does not slow the cases where
 * there is nothing for it to accelerate. Three shapes, not one: a single
 * pack with no midx, a loose-only repository (the §D4.5 `assertLoadable`
 * gate in isolation), and the many-pack win itself, with and without a
 * midx, for both a hit-in-the-first-pack and a hit-in-the-last-pack
 * workload. Published numbers come from the CI nightly `bench.yml`
 * artefact, never a local run — session load has been shown to bias
 * syscall-heavy paths by up to 2.4x.
 */
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { BenchComparison } from './support/bench-dsl.js';
import {
  LOOSE_ONLY_FIXTURE,
  MANY_PACK_FIXTURE,
  MANY_PACK_FIXTURE_NO_MIDX,
  type ScaledFixture,
  SINGLE_PACK_FIXTURE,
} from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

/** Opens the fixture's repository once and reads `blobId` on every measured call — isolates the lookup cost from the per-call `openRepository` cost. */
const readBlobBench = async (
  fixture: ScaledFixture,
  blobId: ObjectId,
): Promise<BenchComparison> => {
  const repo = await openRepository({ cwd: fixture.cwd });
  return {
    teardown: () => repo.dispose(),
    sut: async (): Promise<void> => {
      await repo.primitives.readBlob(blobId);
    },
  };
};

const requireLastBlobId = (fixture: ScaledFixture): ObjectId => {
  if (fixture.lastBlobId === undefined) {
    throw new Error(`${fixture.spec.label}: fixture is missing lastBlobId`);
  }
  return fixture.lastBlobId as ObjectId;
};

/**
 * Opens, reads once and disposes on EVERY measured call — the cold-open
 * shape that prices the scan itself: with a usable midx the first read costs
 * one midx read instead of P whole-file `.idx` reads, which is the dominant
 * term the warm rows amortise away.
 */
const coldOpenBench = async (
  fixture: ScaledFixture,
  blobId: ObjectId,
): Promise<BenchComparison> => ({
  sut: async (): Promise<void> => {
    const repo = await openRepository({ cwd: fixture.cwd });
    try {
      await repo.primitives.readBlob(blobId);
    } finally {
      await repo.dispose();
    }
  },
});

const singlePackCtx = await resolveScaledContext(SINGLE_PACK_FIXTURE);
scaledScenario(
  singlePackCtx,
  'When readBlob() resolves the only pack (P = 1, no midx), Then measure tsgit',
  (fixture) => readBlobBench(fixture, fixture.firstBlobId as ObjectId),
);

const looseOnlyCtx = await resolveScaledContext(LOOSE_ONLY_FIXTURE);
scaledScenario(
  looseOnlyCtx,
  'When readBlob() resolves a loose object with no packs (the assertLoadable gate, isolated), Then measure tsgit',
  (fixture) => readBlobBench(fixture, fixture.firstBlobId as ObjectId),
);

const manyPackWithMidxCtx = await resolveScaledContext(MANY_PACK_FIXTURE);
scaledScenario(
  manyPackWithMidxCtx,
  'When readBlob() hits the first pack with a midx present, Then measure tsgit',
  (fixture) => readBlobBench(fixture, fixture.firstBlobId as ObjectId),
);
scaledScenario(
  manyPackWithMidxCtx,
  'When readBlob() hits the last pack with a midx present, Then measure tsgit',
  (fixture) => readBlobBench(fixture, requireLastBlobId(fixture)),
);

const manyPackNoMidxCtx = await resolveScaledContext(MANY_PACK_FIXTURE_NO_MIDX);
scaledScenario(
  manyPackNoMidxCtx,
  'When readBlob() hits the first pack with no midx, Then measure tsgit',
  (fixture) => readBlobBench(fixture, fixture.firstBlobId as ObjectId),
);
scaledScenario(
  manyPackNoMidxCtx,
  'When readBlob() hits the last pack with no midx, Then measure tsgit',
  (fixture) => readBlobBench(fixture, requireLastBlobId(fixture)),
);

scaledScenario(
  manyPackWithMidxCtx,
  'When a cold open reads one blob with a midx present, Then measure tsgit',
  (fixture) => coldOpenBench(fixture, fixture.firstBlobId as ObjectId),
);
scaledScenario(
  manyPackNoMidxCtx,
  'When a cold open reads one blob with no midx, Then measure tsgit',
  (fixture) => coldOpenBench(fixture, fixture.firstBlobId as ObjectId),
);
scaledScenario(
  looseOnlyCtx,
  'When a cold open reads one loose blob with no packs, Then measure tsgit',
  (fixture) => coldOpenBench(fixture, fixture.firstBlobId as ObjectId),
);

/** The streamed loose path pays the same assertLoadable gate as readBlob —
 *  its own cold-open row keeps that surface pinned separately. */
const streamColdOpenBench = async (
  fixture: ScaledFixture,
  blobId: ObjectId,
): Promise<BenchComparison> => ({
  sut: async (): Promise<void> => {
    const repo = await openRepository({ cwd: fixture.cwd });
    try {
      for await (const chunk of await repo.primitives.streamBlob(blobId)) {
        void chunk;
      }
    } finally {
      await repo.dispose();
    }
  },
});

scaledScenario(
  looseOnlyCtx,
  'When a cold open streams one loose blob with no packs, Then measure tsgit',
  (fixture) => streamColdOpenBench(fixture, fixture.firstBlobId as ObjectId),
);
