/**
 * Properties of git's trivial in-index merge: it is symmetric in its two
 * sides, and a side merged with itself — deleting nothing — yields that side.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import { trivialMerge } from '../../../../src/domain/merge/trivial-merge.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';

const entry = fc
  .record({
    id: fc.constantFrom('a', 'b', 'c').map((id) => id.padEnd(40, '0') as ObjectId),
    mode: fc.constantFrom('100644', '100755').map((mode) => mode as FileMode),
  })
  .map((generated): FlatTreeEntry => ({ ...generated }));
const flatTree = fc
  .dictionary(fc.constantFrom('f', 'g', 'd/x', 'd'), entry, { maxKeys: 4 })
  .map((entries) => new Map(Object.entries(entries) as Array<[FilePath, FlatTreeEntry]>));

describe('trivialMerge properties', () => {
  describe('Given any base and two sides', () => {
    describe('When the sides are swapped', () => {
      it('Then the trivial result holds the same entries', () => {
        // Arrange
        const sut = trivialMerge;

        // Act + Assert
        fc.assert(
          fc.property(flatTree, flatTree, flatTree, (base, ours, theirs) => {
            const result = sut(base, ours, theirs);
            const swapped = sut(base, theirs, ours);
            expect(swapped === undefined ? undefined : new Map([...swapped].sort())).toEqual(
              result === undefined ? undefined : new Map([...result].sort()),
            );
          }),
        );
      });
    });
  });

  describe('Given a side free of directory clashes keeping every base path', () => {
    describe('When the side is merged with itself', () => {
      it('Then the result is that side', () => {
        // Arrange
        const sut = trivialMerge;
        const clean = flatTree.filter(
          (tree) => !(tree.has('d' as FilePath) && tree.has('d/x' as FilePath)),
        );

        // Act + Assert
        fc.assert(
          fc.property(flatTree, clean, (base, side) => {
            fc.pre([...base.keys()].every((path) => side.has(path)));
            expect(sut(base, side, side)).toEqual(side);
          }),
        );
      });
    });
  });
});
