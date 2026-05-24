import { describe, expect, it } from 'vitest';
import { readBlob } from '../../../../src/application/primitives/read-blob.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, Commit, ObjectId, Tag, Tree } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

describe('readBlob', () => {
  describe('Given a seeded blob id', () => {
    describe('When readBlob is called', () => {
      it('Then returns the Blob', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([9]), id: '' as ObjectId };
        const id = await writeObject(ctx, blob);
        const sut = await readBlob(ctx, id);
        // Assert
        expect(sut.type).toBe('blob');
      });
    });
  });

  describe('Given a tree id', () => {
    describe('When readBlob is called', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE with expected="blob", actual="tree"', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const id = await writeObject(ctx, tree);
        try {
          await readBlob(ctx, id);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
          if (data.code === 'UNEXPECTED_OBJECT_TYPE') {
            expect(data.expected).toBe('blob');
            expect(data.actual).toBe('tree');
          }
        }
      });
    });
  });

  describe('Given a commit id', () => {
    describe('When readBlob is called', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE actual="commit"', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        // Build a small commit pointing at an empty tree
        const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, tree);
        const commit: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
            committer: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
            message: 'm',
            extraHeaders: [],
          },
        };
        const id = await writeObject(ctx, commit);
        try {
          await readBlob(ctx, id);
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          if (data.code === 'UNEXPECTED_OBJECT_TYPE') {
            expect(data.actual).toBe('commit');
          }
        }
      });
    });
  });

  describe('Given a tag id', () => {
    describe('When readBlob is called', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE actual="tag"', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, tree);
        const tag: Tag = {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: treeId,
            objectType: 'tree',
            tagName: 'v1',
            tagger: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
            message: 'm',
            extraHeaders: [],
          },
        };
        const id = await writeObject(ctx, tag);
        try {
          await readBlob(ctx, id);
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          if (data.code === 'UNEXPECTED_OBJECT_TYPE') {
            expect(data.actual).toBe('tag');
          }
        }
      });
    });
  });

  describe('Given options.verifyHash=false', () => {
    describe('When readBlob is called', () => {
      it('Then propagates through readObject', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([7]), id: '' as ObjectId };
        const id = await writeObject(ctx, blob);
        const sut = await readBlob(ctx, id, { verifyHash: false });
        // Assert
        expect(sut.type).toBe('blob');
      });
    });
  });

  describe('Given options.maxBytes within bounds', () => {
    describe('When readBlob is called', () => {
      it('Then returns the Blob (passthrough)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = {
          type: 'blob',
          content: new Uint8Array([1, 2, 3, 4]),
          id: '' as ObjectId,
        };
        const id = await writeObject(ctx, blob);
        const sut = await readBlob(ctx, id, { maxBytes: 4 });
        // Assert
        expect(sut.content).toEqual(new Uint8Array([1, 2, 3, 4]));
      });
    });
  });

  describe('Given options.maxBytes below the blob size', () => {
    describe('When readBlob is called', () => {
      it('Then throws OBJECT_TOO_LARGE (passthrough)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = {
          type: 'blob',
          content: new Uint8Array([1, 2, 3, 4, 5]),
          id: '' as ObjectId,
        };
        const id = await writeObject(ctx, blob);
        try {
          await readBlob(ctx, id, { maxBytes: 4 });
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_TOO_LARGE');
          if (data.code === 'OBJECT_TOO_LARGE') {
            expect(data.id).toBe(id);
            expect(data.actualSize).toBe(5);
            expect(data.limit).toBe(4);
          }
        }
      });
    });
  });
});
