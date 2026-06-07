import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { MatchedPatch } from '../../../../src/domain/range-diff/correspond.js';
import { interleave } from '../../../../src/domain/range-diff/interleave.js';

const oid = (n: number): ObjectId => `${n}`.padStart(40, '0') as ObjectId;

const make = (count: number, matching: ReadonlyArray<number>): MatchedPatch[] =>
  Array.from({ length: count }, (_, index) => ({
    patch: {
      id: oid(index),
      subject: `s${index}`,
      patch: `p${index}`,
      diff: `d${index}`,
      diffsize: 1,
    },
    matching: matching[index]!,
  }));

// A valid partial matching: pair old[i] -> distinct new partners (a reordering).
const arbScenario = fc
  .tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }))
  .chain(([n, m]) =>
    fc
      .uniqueArray(fc.integer({ min: 0, max: Math.max(0, m - 1) }), {
        maxLength: Math.min(n, m),
      })
      .map((partners) => {
        const oldMatching = new Array<number>(n).fill(-1);
        const newMatching = new Array<number>(m).fill(-1);
        partners.forEach((newIndex, oldIndex) => {
          if (oldIndex < n && newIndex < m) {
            oldMatching[oldIndex] = newIndex;
            newMatching[newIndex] = oldIndex;
          }
        });
        return { n, m, oldMatching, newMatching };
      }),
  );

describe('Given an arbitrary valid partial matching of two series', () => {
  describe('When interleaved', () => {
    it('Then every old and new position appears exactly once', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbScenario, ({ n, m, oldMatching, newMatching }) => {
          const entries = interleave(make(n, oldMatching), make(m, newMatching));
          const oldPositions = entries.flatMap((e) => (e.old ? [e.old.position] : []));
          const newPositions = entries.flatMap((e) => (e.new ? [e.new.position] : []));
          expect([...oldPositions].sort((a, b) => a - b)).toEqual(
            Array.from({ length: n }, (_, i) => i + 1),
          );
          expect([...newPositions].sort((a, b) => a - b)).toEqual(
            Array.from({ length: m }, (_, i) => i + 1),
          );
        }),
        { numRuns: 100 },
      );
    });

    it('Then the new-side positions are emitted in strictly increasing order', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbScenario, ({ n, m, oldMatching, newMatching }) => {
          const entries = interleave(make(n, oldMatching), make(m, newMatching));
          const newPositions = entries.flatMap((e) => (e.new ? [e.new.position] : []));
          for (let k = 1; k < newPositions.length; k++) {
            expect(newPositions[k]!).toBeGreaterThan(newPositions[k - 1]!);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
