import { describe, expect, it } from 'vitest';

import { createTreeEntry } from '../../../../../src/application/primitives/snapshot/tree-entry.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type {
  Blob,
  FileMode,
  FilePath,
  ObjectId,
} from '../../../../../src/domain/objects/index.js';
import type { TreeEntryRow } from '../../../../../src/domain/snapshot/index.js';
import { buildSeededContext } from '../fixtures.js';

const writeTestBlob = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: Uint8Array,
): Promise<ObjectId> => {
  const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
  return writeObject(ctx, blob);
};

describe('createTreeEntry', () => {
  describe('Given a TreeEntryRow for an existing blob', () => {
    describe('When createTreeEntry wraps it', () => {
      it('Then the returned entry exposes the row fields unchanged', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeTestBlob(ctx, new Uint8Array([1, 2, 3]));
        const row: TreeEntryRow = {
          source: 'tree',
          path: 'a.txt' as FilePath,
          oid: id,
          mode: '100644' as FileMode,
          kind: 'file',
        };

        // Act
        const sut = createTreeEntry(ctx, row);

        // Assert
        expect(sut.source).toBe('tree');
        expect(sut.path).toBe('a.txt');
        expect(sut.oid).toBe(id);
        expect(sut.mode).toBe('100644');
        expect(sut.kind).toBe('file');
      });
    });
  });

  describe('Given a TreeEntry whose oid points at known blob bytes', () => {
    describe('When read() is called', () => {
      it('Then it returns the blob content as Uint8Array', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new Uint8Array([10, 20, 30, 40]);
        const id = await writeTestBlob(ctx, content);
        const row: TreeEntryRow = {
          source: 'tree',
          path: 'data.bin' as FilePath,
          oid: id,
          mode: '100644' as FileMode,
          kind: 'file',
        };
        const sut = createTreeEntry(ctx, row);

        // Act
        const bytes = await sut.read();

        // Assert
        expect(bytes).toEqual(content);
      });
    });
  });

  describe('Given a TreeEntry whose oid points at a non-blob object', () => {
    describe('When read() is called', () => {
      it('Then it throws UNEXPECTED_OBJECT_TYPE with expected="blob"', async () => {
        // Arrange — seed a tree object (not a blob) and use its id
        const ctx = await buildSeededContext({
          objects: [{ type: 'tree', id: '' as ObjectId, entries: [] }],
        });
        const treeOid = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [],
        });
        const row: TreeEntryRow = {
          source: 'tree',
          path: 'subdir' as FilePath,
          oid: treeOid,
          mode: '40000' as FileMode,
          kind: 'submodule',
        };
        const sut = createTreeEntry(ctx, row);

        // Act + Assert
        await expect(sut.read()).rejects.toMatchObject({
          data: { code: 'UNEXPECTED_OBJECT_TYPE', expected: 'blob' },
        });
      });
    });
  });
});
