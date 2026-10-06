import { describe, expect, it } from 'vitest';
import type { FlatTree, FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import {
  applyMergeRenames,
  collidingSourceMerges,
  type MergeRenames,
  NO_MERGE_RENAMES,
} from '../../../../src/domain/merge/merge-renames.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const ID_BASE = 'a'.repeat(40) as ObjectId;
const ID_EDIT = 'b'.repeat(40) as ObjectId;
const ID_OTHER = 'c'.repeat(40) as ObjectId;
const ID_MERGED = 'd'.repeat(40) as ObjectId;
const ID_ADDED = 'e'.repeat(40) as ObjectId;

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

  describe('Given an edited rename onto an addition whose source the caller content-merged', () => {
    describe('When the renames are applied', () => {
      it('Then the merged source replaces the rename for the add/add and the source is vacated', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([
          [NEW, ID_ADDED],
          [OLD, ID_EDIT],
        ]);
        const theirs = tree([[NEW, ID_OTHER]]);
        const renames: MergeRenames = {
          ours: [],
          theirs: [{ oldPath: OLD, newPath: NEW, mergedSource: entry(ID_MERGED) }],
        };
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(listed(result.base)).toEqual([]);
        expect(listed(result.ours)).toEqual([[NEW, entry(ID_ADDED)]]);
        expect(listed(result.theirs)).toEqual([[NEW, entry(ID_MERGED)]]);
        expect([...result.vacated]).toEqual([OLD]);
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
        expect(result.splitRenames).toEqual([
          {
            base: entry(ID_BASE),
            paths: { base: OLD, ours: NEW, theirs: 'other' },
            ours: entry(ID_EDIT),
            theirs: entry(ID_OTHER),
          },
        ]);
      });
    });
  });

  describe('Given both sides rename one source apart and theirs also adds at our destination', () => {
    describe('When the renames are applied', () => {
      it('Then no split is recorded for a content merge', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([[NEW, ID_EDIT]]);
        const theirs = tree([
          ['other', ID_OTHER],
          [NEW, ID_ADDED],
        ]);
        const renames: MergeRenames = {
          ours: RENAME,
          theirs: [{ oldPath: OLD, newPath: 'other' as FilePath }],
        };
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(result.splitRenames).toEqual([]);
      });
    });
  });

  describe('Given both sides rename one source apart and ours also adds at their destination', () => {
    describe('When the renames are applied', () => {
      it('Then their destination is left to merge as an add/add, the rest forced', () => {
        // Arrange
        const ID_ADDED = 'd'.repeat(40) as ObjectId;
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([
          [NEW, ID_EDIT],
          ['other', ID_ADDED],
        ]);
        const theirs = tree([['other' as FilePath, ID_OTHER]]);
        const renames: MergeRenames = {
          ours: RENAME,
          theirs: [{ oldPath: OLD, newPath: 'other' as FilePath }],
        };
        const sut = applyMergeRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect([...result.forced.keys()]).toEqual([OLD, NEW]);
        expect(result.ours?.entries.get('other' as FilePath)?.id).toBe(ID_ADDED);
        expect(result.theirs?.entries.get('other' as FilePath)?.id).toBe(ID_OTHER);
        expect(result.splitRenames).toEqual([]);
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

describe('collidingSourceMerges', () => {
  describe('Given theirs renames and edits a source ours edited and whose destination ours added', () => {
    describe('When the source merges are listed', () => {
      it('Then the source is merged at its old path with each side at the path it holds', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([
          [NEW, ID_ADDED],
          [OLD, ID_EDIT],
        ]);
        const theirs = tree([[NEW, ID_OTHER]]);
        const renames: MergeRenames = { ours: [], theirs: RENAME };
        const sut = collidingSourceMerges;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(result).toEqual([
          {
            rename: RENAME[0],
            mode: FILE_MODE.REGULAR,
            merge: {
              path: OLD,
              baseId: ID_BASE,
              ourId: ID_EDIT,
              theirId: ID_OTHER,
              baseMode: FILE_MODE.REGULAR,
              ourMode: FILE_MODE.REGULAR,
              theirMode: FILE_MODE.REGULAR,
              sidePaths: { base: OLD, ours: OLD, theirs: NEW },
              extraMarkerSize: 1,
            },
          },
        ]);
      });
    });
  });

  describe('Given ours renames and edits a source theirs edited and whose destination theirs added', () => {
    describe('When the source merges are listed', () => {
      it('Then our renamed entry is merged as ours and theirs keeps the old path', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([[NEW, ID_OTHER]]);
        const theirs = {
          entries: new Map([
            [NEW, entry(ID_ADDED)],
            [OLD, { id: ID_EDIT, mode: FILE_MODE.EXECUTABLE }],
          ]),
        };
        const sut = collidingSourceMerges;

        // Act
        const result = sut(base, ours, theirs, { ours: RENAME, theirs: [] });

        // Assert
        expect(result).toEqual([
          {
            rename: RENAME[0],
            mode: FILE_MODE.EXECUTABLE,
            merge: {
              path: OLD,
              baseId: ID_BASE,
              ourId: ID_OTHER,
              theirId: ID_EDIT,
              baseMode: FILE_MODE.REGULAR,
              ourMode: FILE_MODE.REGULAR,
              theirMode: FILE_MODE.EXECUTABLE,
              sidePaths: { base: OLD, ours: NEW, theirs: OLD },
              extraMarkerSize: 1,
            },
          },
        ]);
      });
    });
  });

  describe('Given ours renames a source into an executable while theirs edits it', () => {
    describe('When the source merges are listed', () => {
      it("Then the source's mode is the mode ours changed it to", () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = { entries: new Map([[NEW, { id: ID_OTHER, mode: FILE_MODE.EXECUTABLE }]]) };
        const theirs = tree([
          [NEW, ID_ADDED],
          [OLD, ID_EDIT],
        ]);
        const sut = collidingSourceMerges;

        // Act
        const result = sut(base, ours, theirs, { ours: RENAME, theirs: [] });

        // Assert
        expect(result.map((merge) => merge.mode)).toEqual([FILE_MODE.EXECUTABLE]);
      });
    });
  });

  describe.each([
    ['the rename is unedited', ID_BASE, ID_EDIT, [NEW, ID_ADDED]],
    ['the other side left the source unedited', ID_OTHER, ID_BASE, [NEW, ID_ADDED]],
    ['the other side did not add the destination', ID_OTHER, ID_EDIT, ['elsewhere', ID_ADDED]],
  ] as const)('Given %s', (_label, renamedId, keptId, added) => {
    describe('When the source merges are listed', () => {
      it('Then none is listed', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([added, [OLD, keptId]]);
        const theirs = tree([[NEW, renamedId]]);
        const sut = collidingSourceMerges;

        // Act
        const result = sut(base, ours, theirs, { ours: [], theirs: RENAME });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe.each([
    ['both sides rename the source alike', [NEW]],
    ['both sides rename the source apart', ['other' as FilePath]],
  ] as const)('Given %s', (_label, ourTargets) => {
    describe('When the source merges are listed', () => {
      it('Then none is listed', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([
          [ourTargets[0], ID_EDIT],
          [NEW, ID_ADDED],
        ]);
        const theirs = tree([[NEW, ID_OTHER]]);
        const ourRenames = ourTargets.map((newPath) => ({ oldPath: OLD, newPath }));
        const sut = collidingSourceMerges;

        // Act
        const result = sut(base, ours, theirs, { ours: ourRenames, theirs: RENAME });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a rename whose source the other side deleted while adding its destination', () => {
    describe('When the source merges are listed', () => {
      it('Then none is listed', () => {
        // Arrange
        const base = tree([[OLD, ID_BASE]]);
        const ours = tree([[NEW, ID_ADDED]]);
        const theirs = tree([[NEW, ID_OTHER]]);
        const sut = collidingSourceMerges;

        // Act
        const result = sut(base, ours, theirs, { ours: [], theirs: RENAME });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a rename whose source the base lacks', () => {
    describe('When the source merges are listed', () => {
      it('Then none is listed', () => {
        // Arrange
        const ours = tree([
          [NEW, ID_ADDED],
          [OLD, ID_EDIT],
        ]);
        const theirs = tree([[NEW, ID_OTHER]]);
        const sut = collidingSourceMerges;

        // Act
        const result = sut(tree([]), ours, theirs, { ours: [], theirs: RENAME });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given no base tree', () => {
    describe('When the source merges are listed', () => {
      it('Then none is listed', () => {
        // Arrange
        const sut = collidingSourceMerges;

        // Act
        const result = sut(undefined, tree([]), tree([]), { ours: [], theirs: RENAME });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});
