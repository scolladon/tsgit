/**
 * Properties of carrying paths along a renamed directory: a move never drops
 * or merges a side's entries, `none` moves nothing, and only `conflict` mode
 * marks the moved paths as file locations.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FlatTree, FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import {
  applyDirectoryRenames,
  type DirectoryRenameMode,
} from '../../../../src/domain/merge/directory-renames.js';
import type { MergeRename } from '../../../../src/domain/merge/merge-renames.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';

const PATHS = ['d/a', 'd/b', 'd/c', 'd/s/e', 'n/a', 'n/b', 'n/c', 'm/a', 'x'] as const;

const entry = fc
  .record({
    id: fc.constantFrom('a', 'b').map((id) => id.padEnd(40, '0') as ObjectId),
    mode: fc.constant('100644' as FileMode),
  })
  .map((generated): FlatTreeEntry => ({ ...generated }));

const flatTree = fc.dictionary(fc.constantFrom(...PATHS), entry, { maxKeys: PATHS.length }).map(
  (entries): FlatTree => ({
    entries: new Map(Object.entries(entries) as Array<[FilePath, FlatTreeEntry]>),
  }),
);

const renames = fc
  .array(fc.tuple(fc.constantFrom(...PATHS), fc.constantFrom(...PATHS)), { maxLength: 4 })
  .map(
    (pairs): ReadonlyArray<MergeRename> =>
      pairs.map(([oldPath, newPath]) => ({
        oldPath: oldPath as FilePath,
        newPath: newPath as FilePath,
      })),
  );

const mode = fc.constantFrom<DirectoryRenameMode>('apply', 'conflict', 'none');

const scenario = fc.record({
  base: flatTree,
  ours: flatTree,
  theirs: flatTree,
  ourRenames: renames,
  theirRenames: renames,
  mode,
});

describe('applyDirectoryRenames properties', () => {
  describe('Given any trees, renames and mode', () => {
    describe('When the directory renames are applied', () => {
      it('Then each side keeps exactly as many entries as it had', () => {
        fc.assert(
          fc.property(scenario, ({ base, ours, theirs, ourRenames, theirRenames, mode }) => {
            // Arrange
            const sut = applyDirectoryRenames;

            // Act
            const result = sut(base, ours, theirs, {
              ours: ourRenames,
              theirs: theirRenames,
              directoryRenames: mode,
            });

            // Assert
            expect(result.ours.entries.size).toBe(ours.entries.size);
            expect(result.theirs.entries.size).toBe(theirs.entries.size);
          }),
        );
      });

      it('Then only conflict mode marks file locations, and none moves nothing', () => {
        fc.assert(
          fc.property(scenario, ({ base, ours, theirs, ourRenames, theirRenames, mode }) => {
            // Arrange
            const sut = applyDirectoryRenames;

            // Act
            const result = sut(base, ours, theirs, {
              ours: ourRenames,
              theirs: theirRenames,
              directoryRenames: mode,
            });

            // Assert
            if (mode !== 'conflict') expect(result.fileLocations.size).toBe(0);
            if (mode === 'none') expect(result.vacated.size).toBe(0);
            if (mode === 'conflict') expect(result.fileLocations.size).toBe(result.vacated.size);
          }),
        );
      });
    });
  });
});
