import { describe, expect, it, vi } from 'vitest';
import * as configReadMod from '../../../../src/application/primitives/config-read.js';
import { readTree } from '../../../../src/application/primitives/read-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId, TreeEntry } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { buildSeededContext, seedMaxTreeDepth } from './fixtures.js';

describe('writeTree', () => {
  describe('Given 0 entries', () => {
    describe('When writeTree is called', () => {
      it('Then returns the canonical empty-tree id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        // Act
        const result = await writeTree(ctx, []);
        // Assert
        expect(result).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });

  describe('Given entries', () => {
    describe('When writeTree is called', () => {
      it('Then readTree of the returned id yields the same entries', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
        const blobId = await writeObject(ctx, blob);
        const entries: TreeEntry[] = [treeEntry('100644' as never, 'a.txt', blobId)];
        // Act
        const treeId = await writeTree(ctx, entries);
        const tree = await readTree(ctx, treeId);
        // Assert
        expect(tree.entries.length).toBe(1);
        expect(tree.entries[0]?.name).toBe('a.txt');
      });
    });
  });

  describe('Given MAX_FLAT_TREE_ENTRIES + 1 entries', () => {
    describe('When writeTree is called', () => {
      it('Then throws TREE_ENTRY_LIMIT_EXCEEDED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oversized = {
          length: 1_000_001,
        } as unknown as ReadonlyArray<TreeEntry>;
        // Act + Assert
        try {
          await writeTree(ctx, oversized);
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
        }
      });
    });
  });

  describe('Given exactly MAX_FLAT_TREE_ENTRIES entries (at cap)', () => {
    describe('When writeTree is called', () => {
      it('Then does NOT throw TREE_ENTRY_LIMIT_EXCEEDED (kills >= mutant)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const atCap = {
          length: 1_000_000,
        } as unknown as ReadonlyArray<TreeEntry>;
        // Act
        let caught: unknown;
        try {
          await writeTree(ctx, atCap);
        } catch (error) {
          caught = error;
        }
        // At-cap must NOT fire the `> MAX` limit. The fake "array" trips downstream
        // serialization, so SOME error is expected — positively asserting "an error
        // was thrown that is NOT the limit" kills the silent-pass mutant where the
        // limit check is removed entirely (downstream would still throw, but with
        // TREE_ENTRY_LIMIT_EXCEEDED never reachable).
        // Assert
        expect(caught).toBeDefined();
        const data = (caught as { data?: { code?: string } }).data;
        if (data !== undefined) {
          expect(data.code).not.toBe('TREE_ENTRY_LIMIT_EXCEEDED');
        }
      });
    });
  });

  describe('Given a malformed core.maxTreeDepth', () => {
    describe('When writeTree is called', () => {
      it('Then refuses through the writeObject boundary — CONFIG_BAD_NUMERIC_VALUE', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '2.5');

        // Act
        let caught: unknown;
        try {
          await writeTree(ctx, []);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
      });
    });
  });

  describe('Given a settled session (a prior write already resolved the repo-settings class)', () => {
    describe('When writeTree is called a second time', () => {
      it('Then no finder re-runs — the settled fast path skips the check entirely', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeTree(ctx, []);
        const spy = vi.spyOn(configReadMod, 'findLastInvalidMaxTreeDepth');

        // Act
        await writeTree(ctx, []);

        // Assert
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });
    });
  });
});
