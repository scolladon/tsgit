import { describe, expect, it } from 'vitest';

import { diffRawTrees } from '../../../../src/domain/diff/raw-tree-diff.js';
import { encode, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { TsgitError } from '../../../../src/domain/objects/error.js';
import { FILE_MODE, type FileMode } from '../../../../src/domain/objects/file-mode.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Tree, TreeEntry } from '../../../../src/domain/objects/tree.js';
import { serializeTreeContent } from '../../../../src/domain/objects/tree.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;
const ID_C = 'c'.repeat(40) as ObjectId;
const ID_A_256 = 'a'.repeat(64) as ObjectId;
const ID_B_256 = 'b'.repeat(64) as ObjectId;

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function entry(name: string, mode: FileMode, id: ObjectId): TreeEntry {
  return { name, mode, id };
}

function tree(entries: ReadonlyArray<TreeEntry>): Tree {
  return { type: 'tree', id: ID_A, entries };
}

function canonicalContent(entries: ReadonlyArray<TreeEntry>, hash = SHA1_CONFIG): Uint8Array {
  return serializeTreeContent(tree(entries), hash);
}

// Hand-built raw entry bytes, NOT sorted by serializeTreeContent — used to
// pin the on-disk-order cases (unsorted / duplicate names), which the raw
// walk must accept and stream in file order rather than refuse.
function rawEntry(mode: string, name: string, id: ObjectId): Uint8Array {
  return concatBytes(encode(`${mode} ${name}\0`), hexToBytes(id));
}

function expectInvalidTreeEntry(
  act: () => void,
  expected: { readonly offset: number; readonly reason: string },
): void {
  let caught: unknown;

  try {
    act();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data).toEqual({
    code: 'INVALID_TREE_ENTRY',
    offset: expected.offset,
    reason: expected.reason,
  });
}

describe('diffRawTrees', () => {
  describe('Given zero-length content on both sides', () => {
    describe('When diffRawTrees is called', () => {
      it('Then returns an empty TreeDiff', () => {
        // Arrange
        const sut = diffRawTrees;

        // Act
        const result = sut(new Uint8Array(0), new Uint8Array(0), SHA1_CONFIG);

        // Assert
        expect(result).toEqual({ changes: [] });
      });
    });
  });

  describe('Given undefined old content and undefined new content', () => {
    describe('When diffRawTrees is called', () => {
      it('Then returns an empty TreeDiff', () => {
        // Arrange
        const sut = diffRawTrees;

        // Act
        const result = sut(undefined, undefined, SHA1_CONFIG);

        // Assert
        expect(result).toEqual({ changes: [] });
      });
    });
  });

  describe('Given undefined old content and populated new content', () => {
    describe('When diffRawTrees is called', () => {
      it('Then every new entry is emitted as an add', () => {
        // Arrange
        const newContent = canonicalContent([
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_B),
        ]);
        const sut = diffRawTrees;

        // Act
        const result = sut(undefined, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([
          { type: 'add', newPath: 'a', newId: ID_A, newMode: FILE_MODE.REGULAR },
          { type: 'add', newPath: 'b', newId: ID_B, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given populated old content and undefined new content', () => {
    describe('When diffRawTrees is called', () => {
      it('Then every old entry is emitted as a delete', () => {
        // Arrange
        const oldContent = canonicalContent([
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_B),
        ]);
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, undefined, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'a', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
          { type: 'delete', oldPath: 'b', oldId: ID_B, oldMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given the identical content on both sides', () => {
    describe('When diffRawTrees is called', () => {
      it('Then returns an empty TreeDiff', () => {
        // Arrange
        const content = canonicalContent([
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_B),
        ]);
        const sut = diffRawTrees;

        // Act
        const result = sut(content, content, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([]);
      });
    });
  });

  describe('Given a new entry with no counterpart on the old side', () => {
    describe('When diffRawTrees is called', () => {
      it('Then emits a single add for it, leaving the shared entry untouched', () => {
        // Arrange
        const oldContent = canonicalContent([entry('a', FILE_MODE.REGULAR, ID_A)]);
        const newContent = canonicalContent([
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_B),
        ]);
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([
          { type: 'add', newPath: 'b', newId: ID_B, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given an old entry with no counterpart on the new side', () => {
    describe('When diffRawTrees is called', () => {
      it('Then emits a single delete for it, leaving the shared entry untouched', () => {
        // Arrange
        const oldContent = canonicalContent([
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_B),
        ]);
        const newContent = canonicalContent([entry('a', FILE_MODE.REGULAR, ID_A)]);
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'b', oldId: ID_B, oldMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given the same path with a different oid (same mode)', () => {
    describe('When diffRawTrees is called', () => {
      it('Then emits a single modify', () => {
        // Arrange
        const oldContent = canonicalContent([entry('a', FILE_MODE.REGULAR, ID_A)]);
        const newContent = canonicalContent([entry('a', FILE_MODE.REGULAR, ID_B)]);
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'modify',
            path: 'a',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  // A DIRECTORY mode carries a virtual trailing slash in the merge-join's
  // name comparison (mirroring tree-diff.ts's entryKey), so a REGULAR <->
  // DIRECTORY pair at the same base name is never the same comparison key —
  // it can only ever surface as a delete+add pair (see the "directory entry
  // sharing a base name" case below), never a same-path type-change.
  // type-change is therefore only reachable between two non-directory kinds.
  describe('Given the same path changing kind between two non-directory modes', () => {
    describe('When diffRawTrees is called', () => {
      it('Then 100644 -> 120000 (file to symlink) emits a single type-change', () => {
        // Arrange
        const oldContent = canonicalContent([entry('a', FILE_MODE.REGULAR, ID_A)]);
        const newContent = canonicalContent([entry('a', FILE_MODE.SYMLINK, ID_B)]);
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'type-change',
            path: 'a',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.SYMLINK,
          },
        ]);
      });

      it('Then 100644 -> 160000 (file to gitlink) emits a single type-change', () => {
        // Arrange
        const oldContent = canonicalContent([entry('a', FILE_MODE.REGULAR, ID_A)]);
        const newContent = canonicalContent([entry('a', FILE_MODE.GITLINK, ID_B)]);
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'type-change',
            path: 'a',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.GITLINK,
          },
        ]);
      });
    });
  });

  describe('Given a directory entry whose oid and mode match on both sides', () => {
    describe('When diffRawTrees is called', () => {
      it('Then emits no change (TREESAME)', () => {
        // Arrange
        const oldContent = canonicalContent([entry('dir', FILE_MODE.DIRECTORY, ID_A)]);
        const newContent = canonicalContent([entry('dir', FILE_MODE.DIRECTORY, ID_A)]);
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([]);
      });
    });
  });

  describe('Given directory and file sharing a base name', () => {
    describe('When diffRawTrees is called', () => {
      it('Then the virtual trailing slash keeps them distinct paths (delete then add)', () => {
        // Arrange
        const oldContent = canonicalContent([entry('a', FILE_MODE.REGULAR, ID_A)]);
        const newContent = canonicalContent([entry('a', FILE_MODE.DIRECTORY, ID_B)]);
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toHaveLength(2);
        expect(result.changes[0]).toEqual({
          type: 'delete',
          oldPath: 'a',
          oldId: ID_A,
          oldMode: FILE_MODE.REGULAR,
        });
        expect(result.changes[1]).toEqual({
          type: 'add',
          newPath: 'a',
          newId: ID_B,
          newMode: FILE_MODE.DIRECTORY,
        });
      });
    });
  });

  describe('Given the same oid and a mode differing only by a leading zero (40000 vs 040000)', () => {
    describe('When diffRawTrees is called', () => {
      it('Then emits no change (leading-zero-stripped mode equality)', () => {
        // Arrange — hand-built: serializeTreeContent would normalise '040000'
        // away, so the raw '040000' byte form is written directly.
        const oldContent = rawEntry('40000', 'dir', ID_A);
        const newContent = rawEntry('040000', 'dir', ID_A);
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([]);
      });
    });
  });

  describe('Given entries that force a delete, an add and a modify within one walk', () => {
    describe('When diffRawTrees is called', () => {
      it('Then the changes array preserves byte-sorted interleaving order', () => {
        // Arrange
        const oldContent = canonicalContent([
          entry('a', FILE_MODE.REGULAR, ID_A),
          entry('b', FILE_MODE.REGULAR, ID_B),
        ]);
        const newContent = canonicalContent([
          entry('a', FILE_MODE.REGULAR, ID_C),
          entry('c', FILE_MODE.REGULAR, ID_C),
        ]);
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert — modify 'a', delete 'b', add 'c' in byte order
        expect(result.changes).toEqual([
          {
            type: 'modify',
            path: 'a',
            oldId: ID_A,
            newId: ID_C,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
          { type: 'delete', oldPath: 'b', oldId: ID_B, oldMode: FILE_MODE.REGULAR },
          { type: 'add', newPath: 'c', newId: ID_C, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given an unsorted new tree (b.txt then a.txt) against a canonical old tree', () => {
    describe('When diffRawTrees is called', () => {
      it('Then emits delete a.txt then add a.txt with the same oid on both sides (git-verified)', () => {
        // Arrange — pinned against real git 2.55.0: `diff-tree <canonical> <unsorted>`
        // yields exactly this order for this on-disk layout.
        const oldContent = canonicalContent([
          entry('a.txt', FILE_MODE.REGULAR, ID_A),
          entry('b.txt', FILE_MODE.REGULAR, ID_B),
        ]);
        const newContent = concatBytes(
          rawEntry('100644', 'b.txt', ID_B),
          rawEntry('100644', 'a.txt', ID_A),
        );
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'a.txt', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
          { type: 'add', newPath: 'a.txt', newId: ID_A, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given a duplicate-name new tree (a.txt twice) against a canonical old tree', () => {
    describe('When diffRawTrees is called', () => {
      it('Then emits per-entry results with no refusal (git-verified)', () => {
        // Arrange — pinned against real git 2.55.0: `diff-tree <canonical> <dup>`
        // yields exactly this order for this on-disk layout.
        const oldContent = canonicalContent([
          entry('a.txt', FILE_MODE.REGULAR, ID_A),
          entry('b.txt', FILE_MODE.REGULAR, ID_B),
        ]);
        const newContent = concatBytes(
          rawEntry('100644', 'a.txt', ID_A),
          rawEntry('100644', 'a.txt', ID_B),
        );
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA1_CONFIG);

        // Assert
        expect(result.changes).toEqual([
          { type: 'add', newPath: 'a.txt', newId: ID_B, newMode: FILE_MODE.REGULAR },
          { type: 'delete', oldPath: 'b.txt', oldId: ID_B, oldMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given malformed bytes on the old side', () => {
    describe('When diffRawTrees is called', () => {
      it("Then throws INVALID_TREE_ENTRY 'missing space after mode' at offset 0", () => {
        // Arrange
        const oldContent = concatBytes(encode('100644a.txt\0'), hexToBytes(ID_A));
        const newContent = canonicalContent([entry('a.txt', FILE_MODE.REGULAR, ID_A)]);

        // Act & Assert
        expectInvalidTreeEntry(() => diffRawTrees(oldContent, newContent, SHA1_CONFIG), {
          offset: 0,
          reason: 'missing space after mode',
        });
      });
    });
  });

  describe('Given malformed bytes on the new side', () => {
    describe('When diffRawTrees is called', () => {
      it("Then throws INVALID_TREE_ENTRY 'empty filename' at offset 0", () => {
        // Arrange
        const oldContent = canonicalContent([entry('a.txt', FILE_MODE.REGULAR, ID_A)]);
        const newContent = concatBytes(encode('100644 \0'), hexToBytes(ID_A));

        // Act & Assert
        expectInvalidTreeEntry(() => diffRawTrees(oldContent, newContent, SHA1_CONFIG), {
          offset: 0,
          reason: 'empty filename',
        });
      });
    });
  });

  describe('Given SHA-256 content on both sides', () => {
    describe('When diffRawTrees is called', () => {
      it('Then classifies add/modify/delete using the 32-byte digest width', () => {
        // Arrange
        const oldContent = canonicalContent(
          [entry('a', FILE_MODE.REGULAR, ID_A_256), entry('b', FILE_MODE.REGULAR, ID_B_256)],
          SHA256_CONFIG,
        );
        const newContent = canonicalContent(
          [entry('a', FILE_MODE.REGULAR, ID_B_256)],
          SHA256_CONFIG,
        );
        const sut = diffRawTrees;

        // Act
        const result = sut(oldContent, newContent, SHA256_CONFIG);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'modify',
            path: 'a',
            oldId: ID_A_256,
            newId: ID_B_256,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
          { type: 'delete', oldPath: 'b', oldId: ID_B_256, oldMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });
});
