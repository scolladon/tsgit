import { describe, expect, it } from 'vitest';
import { diffTrees } from '../../../../src/application/primitives/diff-trees.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { Blob, FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

describe('diffTrees', () => {
  it('Given undefined vs undefined, When diffTrees is called, Then returns an empty TreeDiff', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const sut = await diffTrees(ctx, undefined, undefined);
    // Assert
    expect(sut.changes).toEqual([]);
  });

  it('Given a single blob added between two trees, When diffTrees is called, Then yields one AddChange', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
    const blobId = await writeObject(ctx, blob);
    const emptyId = await writeTree(ctx, []);
    const withEntryId = await writeTree(ctx, [
      { name: 'a.txt', mode: '100644' as FileMode, id: blobId },
    ]);
    const sut = await diffTrees(ctx, emptyId, withEntryId);
    // Assert
    expect(sut.changes.length).toBe(1);
    expect(sut.changes[0]?.type).toBe('add');
  });

  it('Given two identical trees, When diffTrees is called, Then returns empty diff', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const emptyId = await writeTree(ctx, []);
    const sut = await diffTrees(ctx, emptyId, emptyId);
    // Assert
    expect(sut.changes).toEqual([]);
  });

  it('Given detectRenames=true and a rename candidate pair, When diffTrees is called, Then invokes rename detection (distinguishable from default)', async () => {
    // Arrange — a delete + add pair on a unique-content blob that the rename
    // detector will collapse into a single 'rename' change.
    const ctx = await buildSeededContext();
    const content = new TextEncoder().encode('unique content for rename detection test');
    const blobId = await writeObject(ctx, {
      type: 'blob',
      content,
      id: '' as ObjectId,
    });
    const before = await writeTree(ctx, [
      { name: 'src.txt', mode: '100644' as FileMode, id: blobId },
    ]);
    const after = await writeTree(ctx, [
      { name: 'dst.txt', mode: '100644' as FileMode, id: blobId },
    ]);

    const withDetect = await diffTrees(ctx, before, after, { detectRenames: true });
    const withoutDetect = await diffTrees(ctx, before, after);

    // Assert — the two results must differ: detectRenames emits a rename,
    // default emits separate delete+add. Kills the BooleanLiteral mutant on
    // `options?.detectRenames === true`.
    expect(withDetect).not.toEqual(withoutDetect);
    expect(withDetect.changes.some((c) => c.type === 'rename')).toBe(true);
  });

  it('Given an already-resolved Tree object passed directly, When diffTrees is called, Then returns the correct diff without invoking readTree', async () => {
    // Arrange — kills the ConditionalExpression mutant at resolveInput's
    // undefined guard.
    const ctx = await buildSeededContext();
    const emptyId = await writeTree(ctx, []);
    const blob: Blob = {
      type: 'blob',
      content: new Uint8Array([1, 2, 3]),
      id: '' as ObjectId,
    };
    const blobId = await writeObject(ctx, blob);
    const treeA = { type: 'tree' as const, id: emptyId, entries: [] };
    const treeB = {
      type: 'tree' as const,
      id: '' as ObjectId,
      entries: [{ name: 'f.txt', mode: '100644' as FileMode, id: blobId }],
    };
    const sut = await diffTrees(ctx, treeA, treeB);

    // Assert
    expect(sut.changes.length).toBe(1);
    expect(sut.changes[0]?.type).toBe('add');
  });
});
