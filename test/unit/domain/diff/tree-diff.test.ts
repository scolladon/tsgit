import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffTrees } from '../../../../src/domain/diff/tree-diff.js';
import type { FileMode, ObjectId, Tree, TreeEntry } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import { arbTree } from './arbitraries.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;
const ID_C = 'c'.repeat(40) as ObjectId;

function tree(entries: ReadonlyArray<TreeEntry>): Tree {
  return {
    type: 'tree',
    id: '0'.repeat(40) as ObjectId,
    entries,
  };
}

function entry(name: string, mode: FileMode, id: ObjectId): TreeEntry {
  return { name, mode, id };
}

describe('diffTrees', () => {
  describe('Given two undefined trees', () => {
    describe('When diffTrees called', () => {
      it('Then returns empty TreeDiff', () => {
        // Arrange & Act
        const sut = diffTrees(undefined, undefined);

        // Assert
        expect(sut).toEqual({ changes: [] });
      });
    });
  });

  describe('Given undefined old tree and new tree with one entry', () => {
    describe('When diffTrees called', () => {
      it('Then returns [AddChange]', () => {
        // Arrange
        const newTree = tree([entry('foo', FILE_MODE.REGULAR, ID_A)]);

        // Act
        const sut = diffTrees(undefined, newTree);

        // Assert
        expect(sut.changes).toEqual([
          { type: 'add', newPath: 'foo', newId: ID_A, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given old tree with one entry and undefined new tree', () => {
    describe('When diffTrees called', () => {
      it('Then returns [DeleteChange]', () => {
        // Arrange
        const oldTree = tree([entry('foo', FILE_MODE.REGULAR, ID_A)]);

        // Act
        const sut = diffTrees(oldTree, undefined);

        // Assert
        expect(sut.changes).toEqual([
          { type: 'delete', oldPath: 'foo', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given same tree on both sides', () => {
    describe('When diffTrees called', () => {
      it('Then returns empty TreeDiff', () => {
        // Arrange
        const t = tree([entry('foo', FILE_MODE.REGULAR, ID_A)]);

        // Act
        const sut = diffTrees(t, t);

        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given same path with different ids (same kind)', () => {
    describe('When diffTrees called', () => {
      it('Then returns [ModifyChange]', () => {
        // Arrange
        const oldTree = tree([entry('foo', FILE_MODE.REGULAR, ID_A)]);
        const newTree = tree([entry('foo', FILE_MODE.REGULAR, ID_B)]);

        // Act
        const sut = diffTrees(oldTree, newTree);

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'modify',
            path: 'foo',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given same path with 100644 → 100755 mode (same kind)', () => {
    describe('When diffTrees called', () => {
      it('Then returns [ModifyChange]', () => {
        // Arrange — same id, different mode, both are "file" kind
        const oldTree = tree([entry('foo', FILE_MODE.REGULAR, ID_A)]);
        const newTree = tree([entry('foo', FILE_MODE.EXECUTABLE, ID_A)]);

        // Act
        const sut = diffTrees(oldTree, newTree);

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'modify',
            path: 'foo',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.EXECUTABLE,
          },
        ]);
      });
    });
  });

  describe('Given same path with 100644 → 120000 (file → symlink)', () => {
    describe('When diffTrees called', () => {
      it('Then returns [TypeChangeChange]', () => {
        // Arrange
        const oldTree = tree([entry('foo', FILE_MODE.REGULAR, ID_A)]);
        const newTree = tree([entry('foo', FILE_MODE.SYMLINK, ID_B)]);

        // Act
        const sut = diffTrees(oldTree, newTree);

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'type-change',
            path: 'foo',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.SYMLINK,
          },
        ]);
      });
    });
  });

  describe('Given same path with file → gitlink', () => {
    describe('When diffTrees called', () => {
      it('Then returns [TypeChangeChange]', () => {
        // Arrange
        const oldTree = tree([entry('sub', FILE_MODE.REGULAR, ID_A)]);
        const newTree = tree([entry('sub', FILE_MODE.GITLINK, ID_B)]);

        // Act
        const sut = diffTrees(oldTree, newTree);

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'type-change',
            path: 'sub',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.GITLINK,
          },
        ]);
      });
    });
  });

  describe('Given mixed add + delete + modify at different paths', () => {
    describe('When diffTrees called', () => {
      it('Then all three emitted', () => {
        // Arrange
        const oldTree = tree([
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_B),
        ]);
        const newTree = tree([
          entry('a', FILE_MODE.REGULAR, ID_C),
          entry('c', FILE_MODE.REGULAR, ID_C),
        ]);

        // Act
        const sut = diffTrees(oldTree, newTree);

        // Assert — modify 'a', delete 'b', add 'c' in byte-order
        expect(sut.changes).toHaveLength(3);
        expect(sut.changes[0]).toEqual({
          type: 'modify',
          path: 'a',
          oldId: ID_A,
          newId: ID_C,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        });
        expect(sut.changes[1]).toEqual({
          type: 'delete',
          oldPath: 'b',
          oldId: ID_B,
          oldMode: FILE_MODE.REGULAR,
        });
        expect(sut.changes[2]).toEqual({
          type: 'add',
          newPath: 'c',
          newId: ID_C,
          newMode: FILE_MODE.REGULAR,
        });
      });
    });
  });

  describe("Given byte-order test across trees ('a','a-' vs 'b','c')", () => {
    describe('When diffTrees called', () => {
      it('Then output sorted by path bytes', () => {
        // Arrange
        const oldTree = tree([
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_B),
        ]);
        const newTree = tree([
          entry('a-', FILE_MODE.REGULAR, ID_A),
          entry('c', FILE_MODE.REGULAR, ID_C),
        ]);

        // Act
        const sut = diffTrees(oldTree, newTree);

        // Assert — sorted primary-key order: 'a' (delete) < 'a-' (add) < 'b' (delete) < 'c' (add)
        const primaryKeys = sut.changes.map((c) => {
          if (c.type === 'add') return c.newPath;
          if (c.type === 'delete') return c.oldPath;
          if (c.type === 'rename') return c.newPath;
          return c.path;
        });
        expect(primaryKeys).toEqual(['a', 'a-', 'b', 'c']);
      });
    });
  });

  describe('Given same path both directory mode with different ids', () => {
    describe('When diffTrees called', () => {
      it('Then returns [ModifyChange] (directory kind preserved)', () => {
        // Arrange
        const oldTree = tree([entry('dir', FILE_MODE.DIRECTORY, ID_A)]);
        const newTree = tree([entry('dir', FILE_MODE.DIRECTORY, ID_B)]);

        // Act
        const sut = diffTrees(oldTree, newTree);

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'modify',
            path: 'dir',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.DIRECTORY,
            newMode: FILE_MODE.DIRECTORY,
          },
        ]);
      });
    });
  });

  describe('Given directory entry sorted with virtual slash', () => {
    describe('When diffTrees called', () => {
      it('Then directory and file sharing base name are distinct paths', () => {
        // Arrange — file 'a' and dir 'a' sort differently ('a' < 'a/'); treated as different entries
        const oldTree = tree([entry('a', FILE_MODE.REGULAR, ID_A)]);
        const newTree = tree([entry('a', FILE_MODE.DIRECTORY, ID_B)]);

        // Act
        const sut = diffTrees(oldTree, newTree);

        // Assert — delete of file 'a' comes before add of dir 'a' (virtual slash appended)
        expect(sut.changes).toHaveLength(2);
        expect(sut.changes[0]?.type).toBe('delete');
        expect(sut.changes[1]?.type).toBe('add');
      });
    });
  });

  describe('Given the property "for any Tree A, diffTrees(A, A).changes is empty"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(arbTree(), (t) => {
            const result = diffTrees(t, t);
            return result.changes.length === 0;
          }),
        );
      });
    });
  });

  describe('Given the property "diffTrees(undefined, X) deep-equals diffTrees({type:"tree", entries:[]}, X) for any X"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(arbTree(), (t) => {
            const a = diffTrees(undefined, t);
            const emptyTree: Tree = {
              type: 'tree',
              id: '0'.repeat(40) as ObjectId,
              entries: [],
            };
            const b = diffTrees(emptyTree, t);
            expect(a).toEqual(b);
          }),
        );
      });
    });
  });
});
