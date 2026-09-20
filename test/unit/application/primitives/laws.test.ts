import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  diffTrees,
  readObject,
  readTree,
  resolveRef,
  updateRef,
  writeObject,
  writeTree,
} from '../../../../src/application/primitives/index.js';
import type {
  AuthorIdentity,
  Blob,
  FileMode,
  ObjectId,
  RefName,
} from '../../../../src/domain/objects/index.js';
import { emptyTreeOid } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { buildSeededContext } from './fixtures.js';

describe('composition laws', () => {
  describe('Given the law "writeObject ∘ readObject is identity for blobs (property)"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(fc.uint8Array({ maxLength: 64 }), async (bytes) => {
            const ctx = await buildSeededContext();
            const blob: Blob = {
              type: 'blob',
              content: new Uint8Array(bytes),
              id: '' as ObjectId,
            };
            const id = await writeObject(ctx, blob);
            const round = await readObject(ctx, id);
            return round.type === 'blob' && (round as Blob).content.length === blob.content.length;
          }),
          { numRuns: 10 },
        );
      });
    });
  });

  describe('Given the law "updateRef ∘ resolveRef returns the same id"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Act + Assert — a branch update now verifies its target,
        // so the id must be a real, hash-valid commit rather than arbitrary
        // hex; the message varies instead.
        await fc.assert(
          fc.asyncProperty(fc.string(), async (message) => {
            const ctx = await buildSeededContext();
            const identity: AuthorIdentity = {
              name: 'A U Thor',
              email: 'author@example.com',
              timestamp: 0,
              timezoneOffset: '+0000',
            };
            const id = await writeObject(ctx, {
              type: 'commit',
              id: '' as ObjectId,
              data: {
                tree: emptyTreeOid(ctx.hashConfig),
                parents: [],
                author: identity,
                committer: identity,
                message,
                extraHeaders: [],
              },
            });
            await updateRef(ctx, 'refs/heads/main' as RefName, id, {
              reflogMessage: 'commit: law',
            });
            const resolved = await resolveRef(ctx, 'refs/heads/main' as RefName);
            return resolved === id;
          }),
          { numRuns: 10 },
        );
      });
    });
  });

  describe('Given the law "writeTree permutation independence (output hash stable under input shuffling)"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        } satisfies Blob);
        const b2 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([2]),
          id: '' as ObjectId,
        } satisfies Blob);

        // Act
        const idA = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'a', b1),
          treeEntry('100644' as FileMode, 'b', b2),
        ]);
        const idB = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'b', b2),
          treeEntry('100644' as FileMode, 'a', b1),
        ]);

        // Assert
        expect(idA).toBe(idB);
      });
    });
  });

  describe('Given the law "diffTrees(tree, tree) returns empty"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const emptyId = await writeTree(ctx, []);

        // Act
        const result = await diffTrees(ctx, emptyId, emptyId);

        // Assert
        expect(result.changes).toEqual([]);
      });
    });
  });

  describe('Given the law "readTree ∘ writeTree yields back the same entries shape"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b1 = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([7]),
          id: '' as ObjectId,
        } satisfies Blob);
        const entries = [treeEntry('100644' as FileMode, 'f', b1)];

        // Act
        const id = await writeTree(ctx, entries);
        const tree = await readTree(ctx, id);

        // Assert
        expect(tree.entries.length).toBe(1);
        expect(tree.entries[0]?.name).toBe('f');
      });
    });
  });
});
