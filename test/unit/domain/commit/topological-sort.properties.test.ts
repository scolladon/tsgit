import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  sortInTopologicalOrder,
  type TopoSortable,
  type TopoSortOrder,
} from '../../../../src/domain/commit/topological-sort.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const oidAt = (index: number): ObjectId => index.toString(16).padStart(40, '0') as ObjectId;

// Commit i may only name parents of a higher index, so every generated graph
// is acyclic; small date ranges keep equal-date ties frequent.
const dagArb: fc.Arbitrary<TopoSortable[]> = fc
  .integer({ min: 0, max: 12 })
  .chain((size) =>
    fc.tuple(
      ...Array.from({ length: size }, (_, index) =>
        fc.record({
          parents: fc.uniqueArray(fc.integer({ min: index + 1, max: size + 2 }), { maxLength: 3 }),
          committed: fc.integer({ min: 0, max: 3 }),
          authored: fc.integer({ min: 0, max: 3 }),
        }),
      ),
    ),
  )
  .map((rows) =>
    rows.map((row, index) => ({
      id: oidAt(index),
      data: {
        parents: row.parents.map(oidAt),
        committer: { timestamp: row.committed },
        author: { timestamp: row.authored },
      },
    })),
  );

const orderArb: fc.Arbitrary<TopoSortOrder> = fc.constantFrom(
  'graph',
  'commit-date',
  'author-date',
);

describe('Given an arbitrary acyclic commit list', () => {
  describe('When sorting it topologically in any order', () => {
    it('Then every commit shows exactly once', () => {
      fc.assert(
        fc.property(dagArb, orderArb, (commits, order) => {
          // Arrange
          const sut = sortInTopologicalOrder;

          // Act
          const result = sut(commits, order);

          // Assert
          expect([...result].map((commit) => commit.id).sort()).toEqual(
            commits.map((commit) => commit.id).sort(),
          );
        }),
        { numRuns: 200 },
      );
    });

    it('Then every listed parent shows after each of its children', () => {
      fc.assert(
        fc.property(dagArb, orderArb, (commits, order) => {
          // Arrange
          const sut = sortInTopologicalOrder;

          // Act
          const result = sut(commits, order);

          // Assert
          const shownAt = new Map(result.map((commit, index) => [commit.id, index]));
          for (const commit of result) {
            for (const parent of commit.data.parents) {
              const parentAt = shownAt.get(parent);
              if (parentAt !== undefined)
                expect(parentAt).toBeGreaterThan(shownAt.get(commit.id) ?? -1);
            }
          }
        }),
        { numRuns: 200 },
      );
    });
  });
});
