import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { scoreTrees, type TreeLister } from '../../../../src/domain/merge/match-trees.js';
import {
  FILE_MODE,
  type ObjectId,
  type TreeEntry,
  treeEntry,
  treeEntryCompare,
} from '../../../../src/domain/objects/index.js';

const MODES = [FILE_MODE.REGULAR, FILE_MODE.SYMLINK, FILE_MODE.DIRECTORY] as const;
const IDS = ['1', '2', '3'].map((digit) => digit.repeat(40) as ObjectId);

function arbTree(): fc.Arbitrary<ReadonlyArray<TreeEntry>> {
  return fc
    .uniqueArray(
      fc.record({
        name: fc.constantFrom('a', 'b', 'c', 'd'),
        mode: fc.constantFrom(...MODES),
        id: fc.constantFrom(...IDS),
      }),
      { selector: (entry) => entry.name, maxLength: 4 },
    )
    .map((entries) =>
      entries.map((entry) => treeEntry(entry.mode, entry.name, entry.id)).sort(treeEntryCompare),
    );
}

const ONE = 'a'.repeat(40) as ObjectId;
const TWO = 'b'.repeat(40) as ObjectId;
const listerOf =
  (one: ReadonlyArray<TreeEntry>, two: ReadonlyArray<TreeEntry>): TreeLister =>
  async (tree) =>
    tree === ONE ? one : two;

describe('match-trees properties', () => {
  describe('Given any two trees', () => {
    describe('When scored both ways', () => {
      it('Then the score is symmetric', async () => {
        // Arrange
        const sut = scoreTrees;
        await fc.assert(
          fc.asyncProperty(arbTree(), arbTree(), async (one, two) => {
            // Act
            const forward = await sut(listerOf(one, two), ONE, TWO);
            const backward = await sut(listerOf(two, one), ONE, TWO);

            // Assert
            expect(forward).toBe(backward);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given any tree', () => {
    describe('When scored against itself', () => {
      it('Then it scores at least as well as against any other tree', async () => {
        // Arrange
        const sut = scoreTrees;
        await fc.assert(
          fc.asyncProperty(arbTree(), arbTree(), async (one, two) => {
            // Act
            const self = await sut(listerOf(one, one), ONE, TWO);
            const other = await sut(listerOf(one, two), ONE, TWO);

            // Assert
            expect(self).toBeGreaterThanOrEqual(other);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
