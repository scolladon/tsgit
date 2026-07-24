import { describe, expect, it } from 'vitest';
import {
  descendTreePath,
  findTreeEntry,
} from '../../../../../src/application/primitives/internal/resolve-tree-path.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { Blob, ObjectId, Tree } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

const blobOf = (byte: number): Blob => ({
  type: 'blob',
  content: new Uint8Array([byte]),
  id: '' as ObjectId,
});

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
        const sut = await descendTreePath(ctx, root, 'file', 'HEAD');
        // Assert
        expect(sut.id).toBe(fileId);
        expect(sut.mode).toBe(FILE_MODE.REGULAR);
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
        const sut = await descendTreePath(ctx, root, 'a/b/c', 'HEAD');
        // Assert
        expect(sut.id).toBe(cId);
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
        const sut = await descendTreePath(ctx, root, 'run', 'HEAD');
        // Assert
        expect(sut.mode).toBe(FILE_MODE.EXECUTABLE);
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
        const sut = await findTreeEntry(ctx, rootId, 'file');
        // Assert
        expect(sut?.id).toBe(fileId);
        expect(sut?.mode).toBe(FILE_MODE.REGULAR);
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
        const sut = await findTreeEntry(ctx, root, 'file');
        // Assert
        expect(sut?.id).toBe(fileId);
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
        const sut = await findTreeEntry(ctx, rootId, 'a/b/c');
        // Assert
        expect(sut?.id).toBe(cId);
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
        const sut = await findTreeEntry(ctx, root, path);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });
});
