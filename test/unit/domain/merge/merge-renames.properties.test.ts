/**
 * Properties of moving renamed paths before the three-way merge: the move is
 * symmetric in its two sides, and it only relocates entries — every tree keeps
 * the same versions it held.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FlatTree, FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import {
  applyMergeRenames,
  type MergeRename,
  type MergeRenames,
  type RenamedMergeInput,
} from '../../../../src/domain/merge/merge-renames.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';

const SOURCES = ['f', 'g', 'h'] as const;
const DESTINATIONS = ['r', 's', 't'] as const;

const entry = fc
  .record({
    id: fc.constantFrom('a', 'b', 'c').map((id) => id.padEnd(40, '0') as ObjectId),
    mode: fc.constantFrom('100644', '100755').map((mode) => mode as FileMode),
  })
  .map((generated): FlatTreeEntry => ({ ...generated }));

const flatTree = (paths: ReadonlyArray<string>) =>
  fc.dictionary(fc.constantFrom(...paths), entry, { maxKeys: paths.length }).map(
    (entries): FlatTree => ({
      entries: new Map(Object.entries(entries) as Array<[FilePath, FlatTreeEntry]>),
    }),
  );

const sideRenames = fc
  .tuple(fc.shuffledSubarray([...SOURCES]), fc.shuffledSubarray([...DESTINATIONS]))
  .map(
    ([olds, news]): ReadonlyArray<MergeRename> =>
      olds.slice(0, news.length).map((old, index) => ({
        oldPath: old as FilePath,
        newPath: news[index] as FilePath,
      })),
  );

/** A renaming side deleted each rename's source and added its destination, as a diff from the base pairs them. */
const renamedSide = (side: FlatTree, renames: ReadonlyArray<MergeRename>, added: FlatTreeEntry) => {
  const entries = new Map(side.entries);
  for (const { oldPath, newPath } of renames) {
    entries.delete(oldPath);
    entries.set(newPath, added);
  }
  return { entries };
};

const scenario = fc
  .record({
    base: flatTree(SOURCES),
    ours: flatTree([...SOURCES, ...DESTINATIONS]),
    theirs: flatTree([...SOURCES, ...DESTINATIONS]),
    renames: fc.record({ ours: sideRenames, theirs: sideRenames }),
    added: entry,
  })
  .map(({ base, ours, theirs, renames, added }) => ({
    base,
    ours: renamedSide(ours, renames.ours, added),
    theirs: renamedSide(theirs, renames.theirs, added),
    renames,
  }));

const versions = (tree: FlatTree | undefined): ReadonlyArray<string> =>
  [...(tree?.entries.values() ?? [])].map((e) => `${e.mode}:${e.id}`).sort();

const swapped = (renames: MergeRenames): MergeRenames => ({
  ours: renames.theirs,
  theirs: renames.ours,
});

const mirrored = (input: RenamedMergeInput) => ({
  base: input.base,
  ours: input.theirs,
  theirs: input.ours,
  vacated: input.vacated,
  sidePaths: new Map(
    [...input.sidePaths].map(([path, sides]) => [
      path,
      { base: sides.base, ours: sides.theirs, theirs: sides.ours },
    ]),
  ),
});

describe('applyMergeRenames properties', () => {
  describe('Given any base, two sides and their renames', () => {
    describe('When the sides and their renames are swapped', () => {
      it('Then the moved trees swap too', () => {
        // Arrange
        const sut = applyMergeRenames;

        // Act + Assert
        fc.assert(
          fc.property(scenario, ({ base, ours, theirs, renames }) => {
            const result = sut(base, ours, theirs, renames);
            const swappedResult = sut(base, theirs, ours, swapped(renames));
            expect(swappedResult).toEqual(mirrored(result));
          }),
        );
      });
    });

    describe('When the renames are applied', () => {
      it('Then every tree keeps the versions it held', () => {
        // Arrange
        const sut = applyMergeRenames;

        // Act + Assert
        fc.assert(
          fc.property(scenario, ({ base, ours, theirs, renames }) => {
            const result = sut(base, ours, theirs, renames);
            expect(versions(result.base)).toEqual(versions(base));
            expect(versions(result.ours)).toEqual(versions(ours));
            expect(versions(result.theirs)).toEqual(versions(theirs));
          }),
        );
      });
    });
  });
});
