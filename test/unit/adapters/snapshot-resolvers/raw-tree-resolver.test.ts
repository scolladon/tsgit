import { describe, expect, it } from 'vitest';

import { createRawTreeResolver } from '../../../../src/adapters/snapshot-resolvers/raw-tree-resolver.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  FILE_MODE,
  type FileMode,
  FilePath,
  type ObjectId,
  type Tree,
} from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../../application/primitives/fixtures.js';

const SAMPLE_OID = '0123456789abcdef0123456789abcdef01234567' as ObjectId;

describe('createRawTreeResolver', () => {
  describe('Given a tree object written to the store', () => {
    describe('When resolve(ctx, treeId) is called with the tree oid', () => {
      it('Then it returns the deserialized Tree with entries intact', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [
            {
              name: FilePath.from('hello.txt'),
              mode: FILE_MODE.REGULAR as FileMode,
              id: SAMPLE_OID,
            },
          ],
        };
        const treeId = await writeObject(ctx, tree);
        const sut = createRawTreeResolver();

        // Act
        const result = await sut.resolve(ctx, treeId);

        // Assert
        expect(result.type).toBe('tree');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.name).toBe('hello.txt');
        expect(result.entries[0]?.id).toBe(SAMPLE_OID);
      });
    });
  });

  describe('Given a blob object written to the store', () => {
    describe('When resolve(ctx, blobId) is called', () => {
      it('Then it throws UNEXPECTED_OBJECT_TYPE with expected="tree" and actual="blob"', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new Uint8Array([1, 2, 3]),
        });
        const sut = createRawTreeResolver();

        // Act + Assert
        await expect(sut.resolve(ctx, blobId)).rejects.toMatchObject({
          data: {
            code: 'UNEXPECTED_OBJECT_TYPE',
            expected: 'tree',
            actual: 'blob',
            id: blobId,
          },
        });
      });
    });
  });

  describe('Given the same tree resolved twice', () => {
    describe('When bypassCache is true on the second call', () => {
      it('Then both calls return the same logical tree (raw resolver ignores options)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [],
        });
        const sut = createRawTreeResolver();

        // Act
        const first = await sut.resolve(ctx, treeId);
        const second = await sut.resolve(ctx, treeId, { bypassCache: true });

        // Assert
        expect(second.entries).toEqual(first.entries);
      });
    });
  });
});
