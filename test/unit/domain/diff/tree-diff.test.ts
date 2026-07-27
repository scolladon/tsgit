import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { diffTrees } from '../../../../src/domain/diff/tree-diff.js';
import * as encodingMod from '../../../../src/domain/objects/encoding.js';
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
        const result = diffTrees(undefined, undefined);

        // Assert
        expect(result).toEqual({ changes: [] });
      });
    });
  });

  describe('Given undefined old tree and new tree with one entry', () => {
    describe('When diffTrees called', () => {
      it('Then returns [AddChange]', () => {
        // Arrange
        const newTree = tree([entry('foo', FILE_MODE.REGULAR, ID_A)]);

        // Act
        const result = diffTrees(undefined, newTree);

        // Assert
        expect(result.changes).toEqual([
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
        const result = diffTrees(oldTree, undefined);

        // Assert
        expect(result.changes).toEqual([
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
        const result = diffTrees(t, t);

        // Assert
        expect(result.changes).toEqual([]);
      });
    });
  });

  describe('Given same path with differing id and/or mode', () => {
    describe('When diffTrees called', () => {
      it.each([
        {
          label: 'different ids (same kind) yields [ModifyChange]',
          path: 'foo',
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
          oldId: ID_A,
          newId: ID_B,
          type: 'modify' as const,
        },
        {
          label: '100644 → 100755 (same kind) yields [ModifyChange]',
          path: 'foo',
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.EXECUTABLE,
          oldId: ID_A,
          newId: ID_A,
          type: 'modify' as const,
        },
        {
          label:
            'both directory mode with different ids yields [ModifyChange] (directory kind preserved)',
          path: 'dir',
          oldMode: FILE_MODE.DIRECTORY,
          newMode: FILE_MODE.DIRECTORY,
          oldId: ID_A,
          newId: ID_B,
          type: 'modify' as const,
        },
        {
          label: '100644 → 120000 (file → symlink) yields [TypeChangeChange]',
          path: 'foo',
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.SYMLINK,
          oldId: ID_A,
          newId: ID_B,
          type: 'type-change' as const,
        },
        {
          label: 'file → gitlink yields [TypeChangeChange]',
          path: 'sub',
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.GITLINK,
          oldId: ID_A,
          newId: ID_B,
          type: 'type-change' as const,
        },
        {
          label: '120000 → 160000 (symlink → gitlink) yields [TypeChangeChange]',
          path: 'sub',
          oldMode: FILE_MODE.SYMLINK,
          newMode: FILE_MODE.GITLINK,
          oldId: ID_A,
          newId: ID_B,
          type: 'type-change' as const,
        },
        {
          label: '160000 → 120000 (gitlink → symlink) yields [TypeChangeChange]',
          path: 'sub',
          oldMode: FILE_MODE.GITLINK,
          newMode: FILE_MODE.SYMLINK,
          oldId: ID_A,
          newId: ID_B,
          type: 'type-change' as const,
        },
      ])('Then $label', ({ path, oldMode, newMode, oldId, newId, type }) => {
        // Arrange
        const oldTree = tree([entry(path, oldMode, oldId)]);
        const newTree = tree([entry(path, newMode, newId)]);

        // Act
        const result = diffTrees(oldTree, newTree);

        // Assert
        expect(result.changes).toEqual([{ type, path, oldId, newId, oldMode, newMode }]);
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
        const result = diffTrees(oldTree, newTree);

        // Assert — modify 'a', delete 'b', add 'c' in byte-order
        expect(result.changes).toHaveLength(3);
        expect(result.changes[0]).toEqual({
          type: 'modify',
          path: 'a',
          oldId: ID_A,
          newId: ID_C,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        });
        expect(result.changes[1]).toEqual({
          type: 'delete',
          oldPath: 'b',
          oldId: ID_B,
          oldMode: FILE_MODE.REGULAR,
        });
        expect(result.changes[2]).toEqual({
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
        const result = diffTrees(oldTree, newTree);

        // Assert — sorted primary-key order: 'a' (delete) < 'a-' (add) < 'b' (delete) < 'c' (add)
        const primaryKeys = result.changes.map((c) => {
          if (c.type === 'add') return c.newPath;
          if (c.type === 'delete') return c.oldPath;
          if (c.type === 'rename' || c.type === 'copy') return c.newPath;
          return c.path;
        });
        expect(primaryKeys).toEqual(['a', 'a-', 'b', 'c']);
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
        const result = diffTrees(oldTree, newTree);

        // Assert — delete of file 'a' comes before add of dir 'a' (virtual slash appended)
        expect(result.changes).toHaveLength(2);
        expect(result.changes[0]?.type).toBe('delete');
        expect(result.changes[1]?.type).toBe('add');
      });
    });
  });

  describe('Given new-tree entries supplied out of byte-sort order', () => {
    describe('When diffTrees is called', () => {
      it('Then changes are still emitted in byte-sorted path order (entriesOf re-sorts, never trusts input array order)', () => {
        // Arrange — entries deliberately scrambled; nothing upstream guarantees the
        // caller's array order matches git's byte-sort order.
        const newTree = tree([
          entry('c', FILE_MODE.REGULAR, ID_C),
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_B),
        ]);

        // Act
        const result = diffTrees(undefined, newTree);

        // Assert — sorted 'a' < 'b' < 'c', not the scrambled input order 'c','a','b'
        const paths = result.changes.map((c) => (c.type === 'add' ? c.newPath : undefined));
        expect(paths).toEqual(['a', 'b', 'c']);
      });
    });
  });

  describe('Given entries that participate in the merge-join', () => {
    describe('When diffTrees is called', () => {
      it('Then each entry name is encoded exactly once (no double TextEncoder pass)', () => {
        // Arrange — 3 entries per side; 'a'/'b' match (TREESAME), 'c' deletes, 'd' adds.
        const oldTree = tree([
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_A),
          entry('c', FILE_MODE.REGULAR, ID_A),
        ]);
        const newTree = tree([
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_A),
          entry('d', FILE_MODE.REGULAR, ID_A),
        ]);
        const encodeSpy = vi.spyOn(encodingMod, 'encode');

        // Act
        diffTrees(oldTree, newTree);

        // Assert — 6 entries total (3 old + 3 new); each name is encoded once,
        // sorted once, then compared via the precomputed key (no re-encode).
        expect(encodeSpy).toHaveBeenCalledTimes(6);
        encodeSpy.mockRestore();
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
