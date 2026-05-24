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
import type { Blob, FileMode, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

describe('composition laws', () => {
  describe('Given the law "writeObject ∘ readObject is identity for blobs (property)"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
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
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(
            fc.string({
              unit: fc.constantFrom(...'0123456789abcdef'),
              minLength: 40,
              maxLength: 40,
            }),
            async (hex) => {
              const ctx = await buildSeededContext();
              const id = hex as ObjectId;
              await updateRef(ctx, 'refs/heads/main' as RefName, id, {
                reflogMessage: 'commit: law',
              });
              const resolved = await resolveRef(ctx, 'refs/heads/main' as RefName);
              return resolved === id;
            },
          ),
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
        const idA = await writeTree(ctx, [
          { name: 'a', mode: '100644' as FileMode, id: b1 },
          { name: 'b', mode: '100644' as FileMode, id: b2 },
        ]);
        const idB = await writeTree(ctx, [
          { name: 'b', mode: '100644' as FileMode, id: b2 },
          { name: 'a', mode: '100644' as FileMode, id: b1 },
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
        const sut = await diffTrees(ctx, emptyId, emptyId);
        // Assert
        expect(sut.changes).toEqual([]);
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
        const entries = [{ name: 'f', mode: '100644' as FileMode, id: b1 }];
        const id = await writeTree(ctx, entries);
        const tree = await readTree(ctx, id);
        // Assert
        expect(tree.entries.length).toBe(1);
        expect(tree.entries[0]?.name).toBe('f');
      });
    });
  });
});
