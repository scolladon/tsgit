import { describe, expect, it } from 'vitest';
import {
  descendTreePath,
  findTreeEntry,
} from '../../../../../src/application/primitives/internal/resolve-tree-path.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import { encode, hexToBytes } from '../../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { Blob, ObjectId, Tree } from '../../../../../src/domain/objects/index.js';
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
          entries: [{ mode: FILE_MODE.REGULAR, name: 'file', id: fileId }],
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
          entries: [{ mode: FILE_MODE.REGULAR, name: 'c', id: cId }],
        } as Tree);
        const aId = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [{ mode: FILE_MODE.DIRECTORY, name: 'b', id: bId }],
        } as Tree);
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [{ mode: FILE_MODE.DIRECTORY, name: 'a', id: aId }],
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
          entries: [{ mode: FILE_MODE.REGULAR, name: 'file', id: fileId }],
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
          entries: [{ mode: FILE_MODE.EXECUTABLE, name: 'run', id: fileId }],
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
          entries: [{ mode: FILE_MODE.REGULAR, name: 'file', id: fileId }],
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
          entries: [{ mode: FILE_MODE.REGULAR, name: 'file', id: fileId }],
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
          entries: [{ mode: FILE_MODE.REGULAR, name: 'c', id: cId }],
        } as Tree);
        const aId = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [{ mode: FILE_MODE.DIRECTORY, name: 'b', id: bId }],
        } as Tree);
        const root: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [{ mode: FILE_MODE.DIRECTORY, name: 'a', id: aId }],
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
                entries: [{ mode: FILE_MODE.REGULAR, name: 'file', id: fileId }],
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
          entries: [{ mode: FILE_MODE.GITLINK, name: 'sub', id: linkId }],
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
          entries: [{ mode: FILE_MODE.SYMLINK, name: 'link', id: linkId }],
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
          { mode: FILE_MODE.REGULAR, name: 'ab', id: abId },
          { mode: FILE_MODE.REGULAR, name: 'ab.txt', id: abTxtId },
        ]);
        const rootId = await writeTree(ctx, [
          { mode: FILE_MODE.DIRECTORY, name: 'dir', id: dirId },
        ]);
        // Act
        const result = await findTreeEntry(ctx, rootId, 'dir/ab');
        // Assert
        expect(result?.name).toBe('ab');
        expect(result?.id).toBe(abId);
      });
    });
  });

  describe('Given a shape-invalid sibling entry in a raw-scanned directory', () => {
    describe('When another entry in the same directory is resolved', () => {
      it.each([
        { label: "'.'", name: '.' },
        { label: "'..'", name: '..' },
        { label: "an embedded '/' ('a/b')", name: 'a/b' },
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
          const rootId = await writeTree(ctx, [
            { mode: FILE_MODE.DIRECTORY, name: 'dir', id: dirId },
          ]);

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
        const rootId = await writeTree(ctx, [
          { mode: FILE_MODE.DIRECTORY, name: 'dir', id: dirId },
        ]);
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
        const rootId = await writeTree(ctx, [
          { mode: FILE_MODE.DIRECTORY, name: 'dir', id: dirId },
        ]);

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
        const rootId = await writeTree(ctx, [
          { mode: FILE_MODE.DIRECTORY, name: 'dir', id: dirId },
        ]);

        // Act
        const result = await findTreeEntry(ctx, rootId, 'dir/a');

        // Assert
        expect(result?.id).toBe(oidA);
      });
    });
  });
});
