import { describe, expect, it, vi } from 'vitest';
import {
  descendMatchingTreeChain,
  descendTreePath,
  findTreeEntry,
  findTreeEntryChain,
} from '../../../../../src/application/primitives/internal/resolve-tree-path.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import { encode, hexToBytes } from '../../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { Blob, ObjectId, Tree } from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import * as treeCursorMod from '../../../../../src/domain/objects/tree-cursor.js';
import { buildSeededContext, writeRawObjectBytes } from '../fixtures.js';

const blobOf = (byte: number): Blob => ({
  type: 'blob',
  content: new Uint8Array([byte]),
  id: '' as ObjectId,
});

const ARBITRARY_OID = 'f'.repeat(40) as ObjectId;

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

/** Hand-built raw entry bytes, planting a directory's on-disk content
 *  exactly (order, mode) rather than through the canonicalising `writeTree`
 *  writer — needed for the unsorted-order and malformed-sibling-mode cases,
 *  which `writeTree` can never produce on its own. */
function rawEntry(mode: string, name: string, id: ObjectId = ARBITRARY_OID): Uint8Array {
  return concatBytes(encode(`${mode} ${name}\0`), hexToBytes(id));
}

function rawEntryByteLength(mode: string, name: string): number {
  return encode(`${mode} ${name}\0`).length + 20;
}

describe('descendTreePath', () => {
  describe('Given a root tree with a top-level file', () => {
    describe('When descendTreePath walks the file name', () => {
      it('Then returns that entry with its id and mode', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fileId = await writeObject(ctx, blobOf(1));
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.REGULAR, 'file', fileId)],
        };
        // Act
        const result = await descendTreePath(ctx, root, 'file', 'HEAD');
        // Assert
        expect(result.id).toBe(fileId);
        expect(result.mode).toBe(FILE_MODE.REGULAR);
      });
    });
  });

  describe('Given a nested tree a/b/c', () => {
    describe('When descendTreePath walks the deep path', () => {
      it('Then returns the deep entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const cId = await writeObject(ctx, blobOf(3));
        const bId = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.REGULAR, 'c', cId)],
        } as Tree);
        const aId = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'b', bId)],
        } as Tree);
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'a', aId)],
        };
        // Act
        const result = await descendTreePath(ctx, root, 'a/b/c', 'HEAD');
        // Assert
        expect(result.id).toBe(cId);
      });
    });
  });

  describe('Given a path whose final segment is absent', () => {
    describe('When descendTreePath walks it', () => {
      it('Then throws PATH_NOT_IN_TREE carrying the rev and path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const root: Tree = { type: 'tree', id: '' as ObjectId, entries: [] };
        // Act / Assert
        try {
          await descendTreePath(ctx, root, 'missing', 'v1.0');
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('PATH_NOT_IN_TREE');
          if (data.code === 'PATH_NOT_IN_TREE') {
            expect(data.rev).toBe('v1.0');
            expect(data.path).toBe('missing');
          }
        }
      });
    });
  });

  describe('Given a path whose intermediate segment is absent', () => {
    describe('When descendTreePath walks it', () => {
      it('Then throws PATH_NOT_IN_TREE', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const root: Tree = { type: 'tree', id: '' as ObjectId, entries: [] };
        // Act / Assert
        try {
          await descendTreePath(ctx, root, 'nope/leaf', 'HEAD');
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('PATH_NOT_IN_TREE');
        }
      });
    });
  });

  describe('Given an intermediate segment that is a blob', () => {
    describe('When descendTreePath descends into it', () => {
      it('Then throws PATH_NOT_IN_TREE', async () => {
        // Arrange — a file used as a directory
        const ctx = await buildSeededContext();
        const fileId = await writeObject(ctx, blobOf(7));
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.REGULAR, 'file', fileId)],
        };
        // Act / Assert
        try {
          await descendTreePath(ctx, root, 'file/leaf', 'HEAD');
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('PATH_NOT_IN_TREE');
        }
      });
    });
  });

  describe('Given an executable entry', () => {
    describe('When descendTreePath returns it', () => {
      it('Then preserves the executable mode', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fileId = await writeObject(ctx, blobOf(5));
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.EXECUTABLE, 'run', fileId)],
        };
        // Act
        const result = await descendTreePath(ctx, root, 'run', 'HEAD');
        // Assert
        expect(result.mode).toBe(FILE_MODE.EXECUTABLE);
      });
    });
  });
});

describe('findTreeEntry', () => {
  describe('Given a root tree oid with a top-level file', () => {
    describe('When findTreeEntry walks the file name', () => {
      it('Then returns that entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fileId = await writeObject(ctx, blobOf(1));
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.REGULAR, 'file', fileId)],
        };
        const rootId = await writeObject(ctx, root);
        // Act
        const result = await findTreeEntry(ctx, rootId, 'file');
        // Assert
        expect(result?.id).toBe(fileId);
        expect(result?.mode).toBe(FILE_MODE.REGULAR);
      });
    });
  });

  describe('Given an already-resolved root Tree', () => {
    describe('When findTreeEntry walks it', () => {
      it('Then returns the entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fileId = await writeObject(ctx, blobOf(2));
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.REGULAR, 'file', fileId)],
        };
        // Act
        const result = await findTreeEntry(ctx, root, 'file');
        // Assert
        expect(result?.id).toBe(fileId);
      });
    });
  });

  describe('Given a nested tree a/b/c oid', () => {
    describe('When findTreeEntry walks the deep path', () => {
      it('Then returns the deep entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const cId = await writeObject(ctx, blobOf(3));
        const bId = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.REGULAR, 'c', cId)],
        } as Tree);
        const aId = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'b', bId)],
        } as Tree);
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'a', aId)],
        };
        const rootId = await writeObject(ctx, root);
        // Act
        const result = await findTreeEntry(ctx, rootId, 'a/b/c');
        // Assert
        expect(result?.id).toBe(cId);
      });
    });
  });

  describe('Given a path that cannot resolve within the tree', () => {
    describe('When findTreeEntry walks it', () => {
      it.each([
        {
          label: 'a path whose final segment is absent',
          arrange: async (): Promise<{ root: Tree; path: string }> => ({
            root: { type: 'tree', id: '' as ObjectId, entries: [] },
            path: 'missing',
          }),
        },
        {
          label: 'a path whose intermediate segment is absent',
          arrange: async (): Promise<{ root: Tree; path: string }> => ({
            root: { type: 'tree', id: '' as ObjectId, entries: [] },
            path: 'nope/leaf',
          }),
        },
        {
          label: 'an intermediate segment that is a blob',
          arrange: async (
            ctx: Awaited<ReturnType<typeof buildSeededContext>>,
          ): Promise<{ root: Tree; path: string }> => {
            const fileId = await writeObject(ctx, blobOf(7));
            return {
              root: {
                type: 'tree',
                id: '' as ObjectId,
                entries: [treeEntry(FILE_MODE.REGULAR, 'file', fileId)],
              },
              path: 'file/leaf',
            };
          },
        },
      ])('Then returns undefined ($label)', async ({ arrange }) => {
        // Arrange
        const ctx = await buildSeededContext();
        const { root, path } = await arrange(ctx);

        // Act
        const result = await findTreeEntry(ctx, root, path);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a directory holding a gitlink leaf', () => {
    describe('When findTreeEntry walks to it', () => {
      it('Then returns the gitlink entry verbatim', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const linkId = await writeObject(ctx, blobOf(9));
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.GITLINK, 'sub', linkId)],
        };
        // Act
        const result = await findTreeEntry(ctx, root, 'sub');
        // Assert
        expect(result?.mode).toBe(FILE_MODE.GITLINK);
        expect(result?.id).toBe(linkId);
      });
    });
  });

  describe('Given a directory holding a symlink leaf', () => {
    describe('When findTreeEntry walks to it', () => {
      it('Then returns the symlink entry verbatim', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const linkId = await writeObject(ctx, blobOf(11));
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.SYMLINK, 'link', linkId)],
        };
        // Act
        const result = await findTreeEntry(ctx, root, 'link');
        // Assert
        expect(result?.mode).toBe(FILE_MODE.SYMLINK);
        expect(result?.id).toBe(linkId);
      });
    });
  });

  describe('Given a raw-scanned directory with an entry name that is a prefix of another', () => {
    describe("When findTreeEntry searches for the shorter name ('ab' alongside 'ab.txt')", () => {
      it('Then returns only the exact-length match', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const abId = await writeObject(ctx, blobOf(1));
        const abTxtId = await writeObject(ctx, blobOf(2));
        const dirId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'ab', abId),
          treeEntry(FILE_MODE.REGULAR, 'ab.txt', abTxtId),
        ]);
        const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dir', dirId)]);
        // Act
        const result = await findTreeEntry(ctx, rootId, 'dir/ab');
        // Assert
        expect(result?.name).toBe('ab');
        expect(result?.id).toBe(abId);
      });
    });
  });

  describe('Given a raw-scanned directory with several valid, non-duplicate entries', () => {
    describe('When findTreeEntry searches for one of them', () => {
      it('Then decodes at most the matched entry — every other sibling is compared as raw bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const cursorNameSpy = vi.spyOn(treeCursorMod, 'cursorName');
        const dirId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a', await writeObject(ctx, blobOf(1))),
          treeEntry(FILE_MODE.REGULAR, 'b', await writeObject(ctx, blobOf(2))),
          treeEntry(FILE_MODE.REGULAR, 'c', await writeObject(ctx, blobOf(3))),
          treeEntry(FILE_MODE.REGULAR, 'ab.txt', await writeObject(ctx, blobOf(4))),
          treeEntry(FILE_MODE.REGULAR, 'ab', await writeObject(ctx, blobOf(5))),
        ]);
        const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dir', dirId)]);
        cursorNameSpy.mockClear();

        // Act
        const result = await findTreeEntry(ctx, rootId, 'dir/ab');

        // Assert — the descent no longer decodes any sibling to find the
        // match: the raw byte-cursor compares candidates directly, and the
        // one decode that does happen lives inside the factory, once, for
        // the entry that is actually returned.
        expect(result?.name).toBe('ab');
        expect(result?.nameBytes).toEqual(encode('ab'));
        expect(cursorNameSpy).toHaveBeenCalledTimes(0);
        cursorNameSpy.mockRestore();
      });
    });
  });

  describe('Given a directory containing names that merely start or end with a dot, or start with two dots', () => {
    describe('When findTreeEntry searches for each of them individually', () => {
      it.each([
        { label: "'.gitmodules' (starts with one dot, length > 1)", name: '.gitmodules' },
        { label: "'..cache' (starts with two dots, length > 2)", name: '..cache' },
        { label: "'.x' (length 2, starts with a dot)", name: '.x' },
        { label: "'a.' (length 2, ends with a dot)", name: 'a.' },
      ])("Then $label resolves — it is not '.', '..', nor slash-bearing", async ({ name }) => {
        // Arrange — each of these shares a byte with the '.'/'..' shape
        // check (a leading dot, or a length-2 span) without actually being
        // '.' or '..'; only the exact match should ever refuse.
        const ctx = await buildSeededContext();
        const fileId = await writeObject(ctx, blobOf(9));
        const dirId = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, name, fileId)]);
        const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dir', dirId)]);

        // Act
        const result = await findTreeEntry(ctx, rootId, `dir/${name}`);

        // Assert
        expect(result?.name).toBe(name);
        expect(result?.id).toBe(fileId);
      });
    });
  });

  describe('Given a shape-invalid sibling entry in a raw-scanned directory', () => {
    describe('When another entry in the same directory is resolved', () => {
      it.each([
        { label: "'.'", name: '.' },
        { label: "'..'", name: '..' },
        { label: "an embedded '/' ('a/b')", name: 'a/b' },
        { label: "a lone '/'", name: '/' },
        { label: "'a/'", name: 'a/' },
        { label: "'/a'", name: '/a' },
        { label: "'//'", name: '//' },
        { label: "'./'", name: './' },
        { label: "'/.'", name: '/.' },
      ])(
        'Then $label refuses eagerly with the invalid-entry-name reason, matching the parsed-root refusal',
        async ({ name }) => {
          // Arrange — the invalid entry sits alongside a valid, differently-
          // named 'good' entry the query actually targets: the full-directory
          // scan (needed for the duplicate-name refusal) sees it regardless
          // of what is being searched for.
          const ctx = await buildSeededContext();
          const content = concatBytes(rawEntry('100644', name), rawEntry('100644', 'good'));
          const dirId = await writeRawObjectBytes(ctx, 'tree', content);
          const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dir', dirId)]);

          // Act / Assert
          try {
            await findTreeEntry(ctx, rootId, 'dir/good');
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(TsgitError);
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_TREE_ENTRY');
            if (data.code === 'INVALID_TREE_ENTRY') {
              expect(data.reason).toBe(`invalid entry name: ${name}`);
            }
          }
        },
      );
    });
  });

  describe('Given a shape-invalid entry at the tree ROOT (chain-descent scan)', () => {
    describe('When findTreeEntryChain scans the root level', () => {
      it.each([
        { label: "'.'", name: '.' },
        { label: "'..'", name: '..' },
        { label: "an embedded '/' ('a/b')", name: 'a/b' },
        { label: "a lone '/'", name: '/' },
        { label: "'a/'", name: 'a/' },
        { label: "'/a'", name: '/a' },
        { label: "'//'", name: '//' },
        { label: "'./'", name: './' },
        { label: "'/.'", name: '/.' },
      ])(
        'Then $label refuses eagerly with the invalid-entry-name reason, at the root — not just an intermediate level',
        async ({ name }) => {
          // Arrange — `descendMatchingTreeChain`'s root-level scan
          // (`scanRootLevel`) shares the same raw-cursor shape check as an
          // intermediate level's `descendOneLevel`, but is a DIFFERENT call
          // site — this pins the refusal fires there too.
          const ctx = await buildSeededContext();
          const content = concatBytes(rawEntry('100644', name), rawEntry('100644', 'good'));
          const rootId = await writeRawObjectBytes(ctx, 'tree', content);

          // Act / Assert
          try {
            await findTreeEntryChain(ctx, rootId, ['good']);
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(TsgitError);
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_TREE_ENTRY');
            if (data.code === 'INVALID_TREE_ENTRY') {
              expect(data.reason).toBe(`invalid entry name: ${name}`);
            }
          }
        },
      );
    });
  });

  describe('Given an empty-name sibling entry in a raw-scanned directory', () => {
    describe('When another entry in the same directory is resolved', () => {
      it("Then it refuses just as eagerly as the slash/dot cases — via the cursor scan's own null-terminator check, one step ahead of the shape check", async () => {
        // Arrange — an empty name (mode + space + immediate NUL) is refused
        // by `TreeCursor`'s own `scanName` before `isInvalidEntryNameBytes`
        // ever runs (see that function's doc), with its own reason text —
        // still `INVALID_TREE_ENTRY`, still eager, still matching
        // `parseTreeContent`'s `name === ''` refusal at the system level.
        const ctx = await buildSeededContext();
        const content = concatBytes(rawEntry('100644', ''), rawEntry('100644', 'good'));
        const dirId = await writeRawObjectBytes(ctx, 'tree', content);
        const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dir', dirId)]);

        // Act / Assert
        try {
          await findTreeEntry(ctx, rootId, 'dir/good');
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_TREE_ENTRY');
          if (data.code === 'INVALID_TREE_ENTRY') {
            expect(data.reason).toBe('empty filename');
          }
        }
      });
    });
  });

  describe('Given a raw-scanned directory with two entries sharing a name', () => {
    describe('When the path descends into it', () => {
      it('Then it refuses with the duplicate-entry-name reason and offset', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const dupOidA = 'a'.repeat(40) as ObjectId;
        const dupOidB = 'b'.repeat(40) as ObjectId;
        const content = concatBytes(
          rawEntry('100644', 'dup', dupOidA),
          rawEntry('100644', 'dup', dupOidB),
        );
        const dirId = await writeRawObjectBytes(ctx, 'tree', content);
        const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dir', dirId)]);
        const expectedOffset = rawEntryByteLength('100644', 'dup');

        // Act / Assert
        try {
          await findTreeEntry(ctx, rootId, 'dir/dup');
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_TREE_ENTRY');
          if (data.code === 'INVALID_TREE_ENTRY') {
            expect(data.reason).toBe('duplicate entry name: dup');
            expect(data.offset).toBe(expectedOffset);
          }
        }
      });
    });
  });

  describe('Given a sibling entry with a malformed mode in a raw-scanned directory', () => {
    describe('When another entry in the same directory is resolved', () => {
      it('Then it refuses eagerly with an invalid-file-mode error', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = concatBytes(rawEntry('77777', 'bad'), rawEntry('100644', 'good'));
        const dirId = await writeRawObjectBytes(ctx, 'tree', content);
        const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dir', dirId)]);

        // Act / Assert
        try {
          await findTreeEntry(ctx, rootId, 'dir/good');
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_FILE_MODE');
          if (data.code === 'INVALID_FILE_MODE') {
            expect(data.value).toBe('77777');
          }
        }
      });
    });
  });

  describe('Given a raw-scanned directory whose entries are not in git sort order', () => {
    describe('When findTreeEntry searches it', () => {
      it('Then the entry is still found', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oidA = 'a'.repeat(40) as ObjectId;
        const oidZ = '9'.repeat(40) as ObjectId;
        const content = concatBytes(rawEntry('100644', 'z', oidZ), rawEntry('100644', 'a', oidA));
        const dirId = await writeRawObjectBytes(ctx, 'tree', content);
        const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dir', dirId)]);

        // Act
        const result = await findTreeEntry(ctx, rootId, 'dir/a');

        // Assert
        expect(result?.id).toBe(oidA);
      });
    });
  });
});

describe('findTreeEntryChain', () => {
  describe('Given a nested tree a/b/c oid', () => {
    describe('When findTreeEntryChain walks the deep path', () => {
      it('Then returns the leaf entry and the per-level oid chain, root through leaf', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const cId = await writeObject(ctx, blobOf(3));
        const bId = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'c', cId)]);
        const aId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'b', bId)]);
        const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'a', aId)]);

        // Act
        const result = await findTreeEntryChain(ctx, rootId, ['a', 'b', 'c']);

        // Assert
        expect(result?.entry.id).toBe(cId);
        expect(result?.oidChain).toEqual([rootId, aId, bId, cId]);
      });
    });
  });

  describe('Given a single top-level segment', () => {
    describe('When findTreeEntryChain resolves it', () => {
      it('Then the chain is exactly [root, leaf]', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fileId = await writeObject(ctx, blobOf(1));
        const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file', fileId)]);

        // Act
        const result = await findTreeEntryChain(ctx, rootId, ['file']);

        // Assert
        expect(result?.oidChain).toEqual([rootId, fileId]);
      });
    });
  });

  describe('Given a path whose intermediate segment is absent', () => {
    describe('When findTreeEntryChain walks it', () => {
      it('Then returns undefined, discarding the partial chain', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rootId = await writeTree(ctx, []);

        // Act
        const result = await findTreeEntryChain(ctx, rootId, ['nope', 'leaf']);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a root oid that is not a tree (a commit whose `tree` field is corrupt)', () => {
    describe('When findTreeEntryChain is asked to descend from it', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE naming the actual type, at every depth', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeObject(ctx, blobOf(9));

        // Act / Assert
        try {
          await findTreeEntryChain(ctx, blobId, ['a', 'b']);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
          if (data.code === 'UNEXPECTED_OBJECT_TYPE') {
            expect(data.expected).toBe('tree');
            expect(data.actual).toBe('blob');
            expect(data.id).toBe(blobId);
          }
        }
      });
    });
  });

  describe('Given a root tree with a non-UTF-8 entry name', () => {
    describe('When findTreeEntryChain searches using the lossy-decoded replacement character', () => {
      it('Then it does not match — the root is compared by raw bytes, not by a lossy decode', async () => {
        // Arrange — a lone continuation byte (0x80) is invalid UTF-8 on its
        // own and decodes to U+FFFD; a decoded-string root comparison would
        // wrongly match a query literally spelled "�" (3 UTF-8 bytes),
        // which never equals the single raw 0x80 byte on disk.
        const ctx = await buildSeededContext();
        const fileId = await writeObject(ctx, blobOf(4));
        const content = concatBytes(encode('100644 '), new Uint8Array([0x80]), new Uint8Array([0]));
        const rootId = await writeRawObjectBytes(
          ctx,
          'tree',
          concatBytes(content, hexToBytes(fileId)),
        );

        // Act
        const result = await findTreeEntryChain(ctx, rootId, ['�']);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('descendMatchingTreeChain', () => {
  describe("Given a parent root oid identical to the child chain's root", () => {
    describe('When descendMatchingTreeChain compares them', () => {
      it("Then returns 'treesame' with the child's own chain, without reading any tree", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rootId = 'f'.repeat(40) as ObjectId;
        const childChain = [rootId, ARBITRARY_OID];

        // Act
        const result = await descendMatchingTreeChain(ctx, rootId, ['a'], childChain);

        // Assert
        expect(result).toEqual({ kind: 'treesame', oidChain: childChain });
      });
    });
  });

  describe('Given a parent whose subtree at the second level matches the child chain', () => {
    describe('When descendMatchingTreeChain descends', () => {
      it("Then returns 'treesame' with THIS root's own (differing) level 0 spliced onto the child's matching tail", async () => {
        // Arrange — parentRootId and childRootId are different oids (distinct
        // tree objects with the same single child entry), but the shared
        // subtree they both point at, and its leaf, are identical.
        const ctx = await buildSeededContext();
        const leafId = await writeObject(ctx, blobOf(2));
        const sharedSubId = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'c', leafId)]);
        const childRootId = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'a', sharedSubId),
          treeEntry(FILE_MODE.REGULAR, 'only-in-child', leafId),
        ]);
        const parentRootId = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'a', sharedSubId),
        ]);
        const childChain = [childRootId, sharedSubId, leafId];

        // Act
        const result = await descendMatchingTreeChain(ctx, parentRootId, ['a', 'c'], childChain);

        // Assert — level 0 is THIS root (parentRootId, genuinely different
        // from childRootId), levels 1-2 are the child's own (guaranteed
        // identical) tail, not re-derived.
        expect(result).toEqual({
          kind: 'treesame',
          oidChain: [parentRootId, sharedSubId, leafId],
        });
      });
    });
  });

  describe('Given a parent that fully diverges from the child chain', () => {
    describe('When descendMatchingTreeChain descends to the leaf', () => {
      it('Then returns the resolved entry and this root’s own oid chain', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const leafId = await writeObject(ctx, blobOf(5));
        const parentRootId = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file', leafId)]);
        const unrelatedChain = [ARBITRARY_OID, ARBITRARY_OID];

        // Act
        const result = await descendMatchingTreeChain(ctx, parentRootId, ['file'], unrelatedChain);

        // Assert
        expect(result).toEqual({
          kind: 'changed',
          entry: treeEntry(FILE_MODE.REGULAR, 'file', leafId),
          oidChain: [parentRootId, leafId],
        });
      });
    });
  });

  describe('Given a root oid that is not a tree', () => {
    describe('When descendMatchingTreeChain is asked to descend from it', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeObject(ctx, blobOf(6));

        // Act / Assert
        try {
          await descendMatchingTreeChain(ctx, blobId, ['a'], [ARBITRARY_OID, ARBITRARY_OID]);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          expect((error as TsgitError).data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        }
      });
    });
  });
});
