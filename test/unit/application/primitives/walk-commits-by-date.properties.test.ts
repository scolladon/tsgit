import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { walkCommitsByDate } from '../../../../src/application/primitives/walk-commits-by-date.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { buildDag, type DagSpec, dagSpecArb } from './arbitraries.js';
import { buildSeededContext } from './fixtures.js';

// Three distinct dates over up to eight commits: equal-date ties are the norm.
const TIE_PRONE_DATES = 3;

const tieProneDagArb: fc.Arbitrary<DagSpec> = dagSpecArb().map((spec) =>
  spec.map((node) => ({ ...node, ts: (node.ts % TIE_PRONE_DATES) + 1 })),
);

const seedsArb = (spec: DagSpec): fc.Arbitrary<number[]> =>
  fc.uniqueArray(fc.integer({ min: 0, max: spec.length - 1 }), { minLength: 1 });

interface Queued {
  readonly index: number;
  readonly arrival: number;
}

const popNext = (spec: DagSpec, queue: Queued[]): Queued => {
  const best = queue.reduce((winner, entry) => {
    const date = spec[entry.index]!.ts;
    const winnerDate = spec[winner.index]!.ts;
    return date > winnerDate || (date === winnerDate && entry.arrival < winner.arrival)
      ? entry
      : winner;
  });
  queue.splice(queue.indexOf(best), 1);
  return best;
};

/** git's commit `prio_queue` walk, by linear scan: newest date, then first enqueued. */
const oracleOrder = (spec: DagSpec, seeds: ReadonlyArray<number>): number[] => {
  const seen = new Set(seeds);
  const queue: Queued[] = seeds.map((index, arrival) => ({ index, arrival }));
  let arrivals = seeds.length;
  const order: number[] = [];
  while (queue.length > 0) {
    const { index } = popNext(spec, queue);
    order.push(index);
    for (const parent of spec[index]!.parents) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push({ index: parent, arrival: arrivals });
      arrivals += 1;
    }
  }
  return order;
};

const collectIds = async (iterable: AsyncIterable<{ readonly id: ObjectId }>) => {
  const ids: ObjectId[] = [];
  for await (const commit of iterable) ids.push(commit.id);
  return ids;
};

describe('walkCommitsByDate properties', () => {
  describe('Given an arbitrary DAG with tie-prone committer dates and arbitrary seeds', () => {
    describe('When walking by date', () => {
      it("Then the order is git's priority-queue order: newest date, then first enqueued", async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(
            tieProneDagArb.chain((spec) => fc.tuple(fc.constant(spec), seedsArb(spec))),
            async ([spec, seeds]) => {
              const ctx = await buildSeededContext();
              const ids = await buildDag(ctx, spec);
              const sut = walkCommitsByDate;

              const result = await collectIds(sut(ctx, { from: seeds.map((i) => ids[i]!) }));

              expect(result).toEqual(oracleOrder(spec, seeds).map((i) => ids[i]!));
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
