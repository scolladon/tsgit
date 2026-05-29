import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mergeBase } from '../../../../src/application/primitives/merge-base.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import {
  ancestorIndices,
  buildDag,
  type DagSpec,
  dagSpecArb,
  oracleBaseIndices,
} from './arbitraries.js';
import { buildSeededContext } from './fixtures.js';

const sortedIds = (ids: readonly ObjectId[]): ObjectId[] => [...ids].sort();

const indicesOf = (all: readonly ObjectId[], subset: readonly ObjectId[]): number[] =>
  subset.map((id) => all.indexOf(id)).sort((x, y) => x - y);

const pick = (spec: DagSpec, raw: number): number => raw % spec.length;

describe('mergeBase properties', () => {
  describe('Given an arbitrary commit DAG and two of its commits', () => {
    describe('When computing all merge bases', () => {
      it('Then the result is symmetric in the two inputs', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(dagSpecArb(), fc.nat(), fc.nat(), async (spec, ra, rb) => {
            const ctx = await buildSeededContext();
            const ids = await buildDag(ctx, spec);
            const a = ids[pick(spec, ra)]!;
            const b = ids[pick(spec, rb)]!;

            const ab = await mergeBase(ctx, [a, b], { all: true });
            const ba = await mergeBase(ctx, [b, a], { all: true });

            expect(sortedIds(ab)).toEqual(sortedIds(ba));
          }),
          { numRuns: 100 },
        );
      });

      it('Then a commit against itself is its own sole base', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(dagSpecArb(), fc.nat(), async (spec, ra) => {
            const ctx = await buildSeededContext();
            const ids = await buildDag(ctx, spec);
            const a = ids[pick(spec, ra)]!;

            const sut = await mergeBase(ctx, [a, a], { all: true });

            expect(sut).toEqual([a]);
          }),
          { numRuns: 100 },
        );
      });

      it('Then every returned base is a common ancestor of both inputs', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(dagSpecArb(), fc.nat(), fc.nat(), async (spec, ra, rb) => {
            const ctx = await buildSeededContext();
            const ids = await buildDag(ctx, spec);
            const ai = pick(spec, ra);
            const bi = pick(spec, rb);

            const bases = await mergeBase(ctx, [ids[ai]!, ids[bi]!], { all: true });

            const ancA = ancestorIndices(spec, ai);
            const ancB = ancestorIndices(spec, bi);
            for (const base of bases) {
              const idx = ids.indexOf(base);
              expect(ancA.has(idx) && ancB.has(idx)).toBe(true);
            }
          }),
          { numRuns: 100 },
        );
      });

      it('Then no returned base is an ancestor of another returned base', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(dagSpecArb(), fc.nat(), fc.nat(), async (spec, ra, rb) => {
            const ctx = await buildSeededContext();
            const ids = await buildDag(ctx, spec);

            const bases = await mergeBase(ctx, [ids[pick(spec, ra)]!, ids[pick(spec, rb)]!], {
              all: true,
            });
            const baseIdx = indicesOf(ids, bases);

            for (const x of baseIdx) {
              for (const y of baseIdx) {
                if (x === y) continue;
                expect(ancestorIndices(spec, y).has(x)).toBe(false);
              }
            }
          }),
          { numRuns: 100 },
        );
      });

      it('Then the result set equals an independent transitive-closure oracle', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(dagSpecArb(), fc.nat(), fc.nat(), async (spec, ra, rb) => {
            const ctx = await buildSeededContext();
            const ids = await buildDag(ctx, spec);
            const ai = pick(spec, ra);
            const bi = pick(spec, rb);

            const bases = await mergeBase(ctx, [ids[ai]!, ids[bi]!], { all: true });

            const expected = oracleBaseIndices(spec, ai, bi)
              .map((i) => ids[i]!)
              .sort();
            expect(sortedIds(bases)).toEqual(expected);
          }),
          { numRuns: 100 },
        );
      });

      it('Then the result is invariant under permuted committer timestamps', async () => {
        // Arrange — same topology, different dates; the date-PQ ordering must not
        // change WHICH commits are bases (only the traversal order).
        await fc.assert(
          fc.asyncProperty(
            dagSpecArb(),
            fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 8, maxLength: 8 }),
            fc.nat(),
            fc.nat(),
            async (spec, altTs, ra, rb) => {
              const reTimed: DagSpec = spec.map((node, i) => ({
                parents: node.parents,
                ts: altTs[i]!,
              }));
              const ai = pick(spec, ra);
              const bi = pick(spec, rb);

              const ctx1 = await buildSeededContext();
              const ids1 = await buildDag(ctx1, spec);
              const bases1 = await mergeBase(ctx1, [ids1[ai]!, ids1[bi]!], { all: true });

              const ctx2 = await buildSeededContext();
              const ids2 = await buildDag(ctx2, reTimed);
              const bases2 = await mergeBase(ctx2, [ids2[ai]!, ids2[bi]!], { all: true });

              // Act + Assert — compare by index, since oids differ across timestamps.
              expect(indicesOf(ids1, bases1)).toEqual(indicesOf(ids2, bases2));
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary commit DAG under octopus mode', () => {
    describe('When folding the merge bases', () => {
      it('Then a two-commit octopus equals the pairwise all-bases set', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(dagSpecArb(), fc.nat(), fc.nat(), async (spec, ra, rb) => {
            const ctx = await buildSeededContext();
            const ids = await buildDag(ctx, spec);
            const a = ids[pick(spec, ra)]!;
            const b = ids[pick(spec, rb)]!;

            const octopus = await mergeBase(ctx, [a, b], { octopus: true, all: true });
            const pairwise = await mergeBase(ctx, [a, b], { all: true });

            expect(sortedIds(octopus)).toEqual(sortedIds(pairwise));
          }),
          { numRuns: 50 },
        );
      });

      it('Then every octopus base is a common ancestor of all inputs', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(dagSpecArb(), fc.nat(), fc.nat(), fc.nat(), async (spec, ra, rb, rc) => {
            const ctx = await buildSeededContext();
            const ids = await buildDag(ctx, spec);
            const picks = [pick(spec, ra), pick(spec, rb), pick(spec, rc)];

            const bases = await mergeBase(
              ctx,
              picks.map((i) => ids[i]!),
              {
                octopus: true,
                all: true,
              },
            );

            const closures = picks.map((i) => ancestorIndices(spec, i));
            for (const base of bases) {
              const idx = ids.indexOf(base);
              expect(closures.every((anc) => anc.has(idx))).toBe(true);
            }
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});
