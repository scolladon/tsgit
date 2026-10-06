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
        expect(listed(result.theirs)).toEqual([[NEW, entry(ID_BASE)]]);
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
        expect(listed(result.ours)).toEqual([[NEW, entry(ID_BASE)]]);
        expect(listed(result.theirs)).toEqual([[NEW, entry(ID_EDIT)]]);
        expect([...result.vacated]).toEqual([OLD]);
        expect(result.sidePaths.get(NEW)).toEqual({ base: OLD, ours: NEW, theirs: OLD });
      });
    });
  });

  describe('Given a rename whose source the other side deleted', () => {
    describe('When the renames are applied', () => {
      it('Then the base moves to the new path and a rename/delete conflict is forced there', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([]);
        const theirs = tree([[NEW, ID_EDIT]]);
        const renames: MergeRenames = { ours: [], theirs: RENAME };
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(listed(result.base)).toEqual([[NEW, entry(ID_BASE)]]);
        expect([...result.vacated]).toEqual([OLD]);
        expect([...result.forced]).toEqual([
          [
            NEW,
            {
              type: 'rename-delete',
              path: NEW,
              baseId: ID_BASE,
              baseMode: FILE_MODE.REGULAR,
              theirId: ID_EDIT,
              theirMode: FILE_MODE.REGULAR,
            },
          ],
        ]);
      });
    });
  });

  describe('Given ours renames a source theirs deleted', () => {
    describe('When the renames are applied', () => {
      it('Then the rename/delete conflict carries our side', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, tree([[NEW, ID_BASE]]), tree([]), { ours: RENAME, theirs: [] });

        // Assert
        expect(result.forced.get(NEW)).toEqual({
          type: 'rename-delete',
          path: NEW,
          baseId: ID_BASE,
          baseMode: FILE_MODE.REGULAR,
          ourId: ID_BASE,
          ourMode: FILE_MODE.REGULAR,
        });
      });
    });
  });

  describe('Given a rename whose destination the other side also added', () => {
    describe('When the renames are applied', () => {
      it("Then the other side's edit of the source replaces the unchanged rename for an add/add", () => {
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
        expect(listed(result.base)).toEqual([]);
        expect(listed(result.ours)).toEqual([[NEW, entry(ID_OTHER)]]);
        expect(listed(result.theirs)).toEqual([[NEW, entry(ID_EDIT)]]);
        expect([...result.vacated]).toEqual([OLD]);
      });
    });
  });

  describe('Given a renamed-and-edited destination the other side also added', () => {
    describe('When the renames are applied', () => {
      it('Then the edited rename joins the add/add as it is', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([
          [NEW, ID_OTHER],
          [OLD, ID_BASE],
        ]);
        const theirs = tree([[NEW, ID_EDIT]]);
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, { ours: [], theirs: RENAME });

        // Assert
        expect(listed(result.theirs)).toEqual([[NEW, entry(ID_EDIT)]]);
        expect([...result.vacated]).toEqual([OLD]);
      });
    });
  });

  describe('Given an edited rename onto a path the other side added over its own edit', () => {
    describe('When the renames are applied', () => {
      it('Then the rename is left untouched', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([
          [NEW, ID_OTHER],
          [OLD, ID_EDIT],
        ]);
        const theirs = tree([[NEW, ID_OTHER]]);
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, { ours: [], theirs: RENAME });

        // Assert
        expect(listed(result.base)).toEqual([[OLD, entry(ID_BASE)]]);
        expect(result.vacated.size).toBe(0);
      });
    });
  });

  describe('Given both sides rename the same source to different paths', () => {
    describe('When the renames are applied', () => {
      it('Then a rename/rename conflict is forced on the source and both destinations', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([[NEW, ID_EDIT]]);
        const theirs = tree([['other' as FilePath, ID_OTHER]]);
        const renames: MergeRenames = {
          ours: RENAME,
          theirs: [{ oldPath: OLD, newPath: 'other' as FilePath }],
        };
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        const regular = FILE_MODE.REGULAR;
        expect([...result.forced]).toEqual([
          [OLD, { type: 'rename-rename', path: OLD, baseId: ID_BASE, baseMode: regular }],
          [NEW, { type: 'rename-rename', path: NEW, ourId: ID_EDIT, ourMode: regular }],
          [
            'other',
            { type: 'rename-rename', path: 'other', theirId: ID_OTHER, theirMode: regular },
          ],
        ]);
        expect(result.vacated.size).toBe(0);
      });
    });
  });

  describe('Given both sides rename the same source to the same path', () => {
    describe('When the renames are applied', () => {
      it('Then only the base moves, for a three-way merge at the new path', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([[NEW, ID_EDIT]]);
        const theirs = tree([[NEW, ID_OTHER]]);
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, { ours: RENAME, theirs: RENAME });

        // Assert
        expect(listed(result.base)).toEqual([[NEW, entry(ID_BASE)]]);
        expect(listed(result.ours)).toEqual([[NEW, entry(ID_EDIT)]]);
        expect(listed(result.theirs)).toEqual([[NEW, entry(ID_OTHER)]]);
        expect([...result.vacated]).toEqual([OLD]);
        expect(result.sidePaths.get(NEW)).toEqual({ base: OLD, ours: NEW, theirs: NEW });
        expect(result.forced.size).toBe(0);
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

describe('applyMergeRenames — rename onto an addition over a deleted source', () => {
  describe('Given theirs renames a source ours deleted while adding the target', () => {
    describe('When the renames are applied', () => {
      it('Then the rename is left untouched', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([[NEW, ID_OTHER]]);
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, tree([[NEW, ID_BASE]]), { ours: [], theirs: RENAME });

        // Assert
        expect(listed(result.base)).toEqual([[OLD, entry(ID_BASE)]]);
        expect(result.vacated.size).toBe(0);
      });
    });
  });
});
