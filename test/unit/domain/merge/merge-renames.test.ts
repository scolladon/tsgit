import { describe, expect, it } from 'vitest';
import type { FlatTree, FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import {
  applyMergeRenames,
  type MergeRenames,
  NO_MERGE_RENAMES,
} from '../../../../src/domain/merge/merge-renames.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const ID_BASE = 'a'.repeat(40) as ObjectId;
const ID_EDIT = 'b'.repeat(40) as ObjectId;
const ID_OTHER = 'c'.repeat(40) as ObjectId;

const entry = (id: ObjectId): FlatTreeEntry => ({ id, mode: FILE_MODE.REGULAR });

const tree = (pairs: ReadonlyArray<readonly [string, ObjectId]>): FlatTree => ({
  entries: new Map(pairs.map(([path, id]) => [path as FilePath, entry(id)] as const)),
});

const OLD = 'old' as FilePath;
const NEW = 'new' as FilePath;
const RENAME = [{ oldPath: OLD, newPath: NEW }];

const listed = (flat: FlatTree | undefined): ReadonlyArray<readonly [FilePath, FlatTreeEntry]> => [
  ...(flat?.entries ?? []),
];

describe('applyMergeRenames', () => {
  describe('Given no renames', () => {
    describe('When the renames are applied', () => {
      it('Then the trees come back untouched with nothing vacated', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([[OLD, ID_EDIT]]);
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, ours, NO_MERGE_RENAMES);

        // Assert
        expect(result.base).toBe(base);
        expect(result.ours).toBe(ours);
        expect(result.theirs).toBe(ours);
        expect(result.vacated.size).toBe(0);
        expect(result.sidePaths.size).toBe(0);
      });
    });
  });

  describe('Given theirs renames a path ours modified', () => {
    describe('When the renames are applied', () => {
      it('Then the base and our edit move to the new path, recording each side path', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([[OLD, ID_EDIT]]);
        const theirs = tree([[NEW, ID_BASE]]);
        const renames: MergeRenames = { ours: [], theirs: RENAME };
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(listed(result.base)).toEqual([[NEW, entry(ID_BASE)]]);
        expect(listed(result.ours)).toEqual([[NEW, entry(ID_EDIT)]]);
        expect(result.theirs).toBe(theirs);
        expect([...result.vacated]).toEqual([OLD]);
        expect(result.sidePaths.get(NEW)).toEqual({ base: OLD, ours: OLD, theirs: NEW });
        expect(listed(base)).toEqual([[OLD, entry(ID_BASE)]]);
      });
    });
  });

  describe('Given ours renames a path theirs modified', () => {
    describe('When the renames are applied', () => {
      it('Then the base and their edit move to the new path, recording each side path', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([[NEW, ID_BASE]]);
        const theirs = tree([[OLD, ID_EDIT]]);
        const renames: MergeRenames = { ours: RENAME, theirs: [] };
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(listed(result.base)).toEqual([[NEW, entry(ID_BASE)]]);
        expect(result.ours).toBe(ours);
        expect(listed(result.theirs)).toEqual([[NEW, entry(ID_EDIT)]]);
        expect([...result.vacated]).toEqual([OLD]);
        expect(result.sidePaths.get(NEW)).toEqual({ base: OLD, ours: NEW, theirs: OLD });
      });
    });
  });

  describe('Given a rename whose source the other side deleted', () => {
    describe('When the renames are applied', () => {
      it('Then the rename is left for its own conflict handling', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([]);
        const theirs = tree([[NEW, ID_BASE]]);
        const renames: MergeRenames = { ours: [], theirs: RENAME };
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(listed(result.base)).toEqual([[OLD, entry(ID_BASE)]]);
        expect(result.vacated.size).toBe(0);
      });
    });
  });

  describe('Given a rename whose destination the other side also added', () => {
    describe('When the renames are applied', () => {
      it('Then the rename is left for its own conflict handling', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([
          [NEW, ID_OTHER],
          [OLD, ID_EDIT],
        ]);
        const theirs = tree([[NEW, ID_BASE]]);
        const renames: MergeRenames = { ours: [], theirs: RENAME };
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(listed(result.ours)).toEqual([
          [NEW, entry(ID_OTHER)],
          [OLD, entry(ID_EDIT)],
        ]);
        expect(result.vacated.size).toBe(0);
      });
    });
  });

  describe('Given both sides rename the same source', () => {
    describe('When the renames are applied', () => {
      it('Then neither rename moves the base', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([[NEW, ID_BASE]]);
        const theirs = tree([['other' as FilePath, ID_BASE]]);
        const renames: MergeRenames = {
          ours: RENAME,
          theirs: [{ oldPath: OLD, newPath: 'other' as FilePath }],
        };
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(listed(result.base)).toEqual([[OLD, entry(ID_BASE)]]);
        expect(result.vacated.size).toBe(0);
      });
    });
  });

  describe('Given no merge base', () => {
    describe('When the renames are applied', () => {
      it('Then nothing moves', () => {
        // Arrange
        const ours = tree([[OLD, ID_EDIT]]);
        const theirs = tree([[NEW, ID_BASE]]);
        const sut = applyMergeRenames;

        // Act
        const result = sut(undefined, ours, theirs, { ours: [], theirs: RENAME });

        // Assert
        expect(result.base).toBeUndefined();
        expect(result.ours).toBe(ours);
        expect(result.vacated.size).toBe(0);
      });
    });
  });
});

describe('applyMergeRenames — absent inputs', () => {
  describe('Given theirs renames and our tree is absent', () => {
    describe('When the renames are applied', () => {
      it('Then our side stays absent', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const theirs = tree([[NEW, ID_BASE]]);
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, undefined, theirs, { ours: [], theirs: RENAME });

        // Assert
        expect(result.ours).toBeUndefined();
        expect(result.vacated.size).toBe(0);
      });
    });
  });

  describe('Given ours renames a source missing from the base', () => {
    describe('When the renames are applied', () => {
      it('Then nothing moves', () => {
        // Arrange
        const base = tree([['elsewhere' as FilePath, ID_BASE]]);
        const theirs = tree([[OLD, ID_EDIT]]);
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, tree([[NEW, ID_BASE]]), theirs, { ours: RENAME, theirs: [] });

        // Assert
        expect(listed(result.theirs)).toEqual([[OLD, entry(ID_EDIT)]]);
        expect(result.vacated.size).toBe(0);
      });
    });
  });
});
