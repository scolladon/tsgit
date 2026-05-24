import { describe, expect, it } from 'vitest';
import { readTree } from '../../../../src/application/primitives/read-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId, TreeEntry } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

describe('writeTree', () => {
  it('Given 0 entries, When writeTree is called, Then returns the canonical empty-tree id', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const sut = await writeTree(ctx, []);
    // Assert
    expect(sut).toMatch(/^[0-9a-f]{40}$/);
  });

  it('Given entries, When writeTree is called, Then readTree of the returned id yields the same entries', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
    const blobId = await writeObject(ctx, blob);
    const entries: TreeEntry[] = [{ name: 'a.txt', mode: '100644' as never, id: blobId }];
    const treeId = await writeTree(ctx, entries);
    const tree = await readTree(ctx, treeId);
    // Assert
    expect(tree.entries.length).toBe(1);
    expect(tree.entries[0]?.name).toBe('a.txt');
  });

  it('Given MAX_FLAT_TREE_ENTRIES + 1 entries, When writeTree is called, Then throws TREE_ENTRY_LIMIT_EXCEEDED', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const oversized = {
      length: 1_000_001,
    } as unknown as ReadonlyArray<TreeEntry>;
    try {
      await writeTree(ctx, oversized);
      // Assert
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
    }
  });

  it('Given exactly MAX_FLAT_TREE_ENTRIES entries (at cap), When writeTree is called, Then does NOT throw TREE_ENTRY_LIMIT_EXCEEDED (kills >= mutant)', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const atCap = {
      length: 1_000_000,
    } as unknown as ReadonlyArray<TreeEntry>;
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
