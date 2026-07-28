import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLATTEN_BOUNDS } from '../../../../../src/application/primitives/internal/flatten-raw.js';
import {
  type Counter,
  type RawSubtreeEntry,
  walkRawSubtree,
} from '../../../../../src/application/primitives/internal/walk-raw-subtree.js';
import * as readObjectMod from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
  SHA1_CONFIG,
  serializeTreeContent,
} from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

type Ctx = Awaited<ReturnType<typeof buildSeededContext>>;

async function writeBlob(ctx: Ctx, content: string): Promise<ObjectId> {
  return writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });
}

/** Drive `walkRawSubtree` and collect every emitted entry, in emission order. */
async function collect(
  ctx: Ctx,
  root: ObjectId,
  bounds = DEFAULT_FLATTEN_BOUNDS,
  prefix = 'top',
  counter: Counter = { value: 0 },
): Promise<RawSubtreeEntry[]> {
  const entries: RawSubtreeEntry[] = [];
  await walkRawSubtree(ctx, root, bounds, prefix, counter, (entry) => entries.push(entry));
  return entries;
}

describe('walkRawSubtree', () => {
  describe('Given a two-level nested subtree', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then emits one entry per tree entry, in DFS pre-order, with full joined paths', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const leafA = await writeBlob(ctx, 'a');
        const leafB = await writeBlob(ctx, 'b');
        const leafC = await writeBlob(ctx, 'c');
        const innerId = await writeTree(ctx, [
          { name: 'c.txt', mode: FILE_MODE.REGULAR, id: leafC },
        ]);
        const dirId = await writeTree(ctx, [
          { name: 'b.txt', mode: FILE_MODE.REGULAR, id: leafB },
          { name: 'inner', mode: FILE_MODE.DIRECTORY, id: innerId },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: leafA },
          { name: 'dir', mode: FILE_MODE.DIRECTORY, id: dirId },
        ]);

        // Act
        const entries = await collect(ctx, rootId);

        // Assert — pre-order: root's own entries first (a.txt, then dir/),
        // then dir's entries (b.txt, then inner/), then inner's entry (c.txt).
        expect(entries).toEqual([
          { path: 'top/a.txt' as FilePath, id: leafA, mode: FILE_MODE.REGULAR },
          { path: 'top/dir/b.txt' as FilePath, id: leafB, mode: FILE_MODE.REGULAR },
          { path: 'top/dir/inner/c.txt' as FilePath, id: leafC, mode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given a directory-mode entry whose oid resolves to a blob', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then the entry is skipped rather than thrown', async () => {
        // Arrange — a directory-mode entry pointing at a blob is silently
        // skipped (never recursed into, never throws), mirroring
        // `flatten-raw.ts`'s identical guard.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'not a tree');
        const otherBlobId = await writeBlob(ctx, 'sibling');
        const treeId = await writeTree(ctx, [
          { name: 'd', mode: FILE_MODE.DIRECTORY, id: blobId },
          { name: 'sibling.txt', mode: FILE_MODE.REGULAR, id: otherBlobId },
        ]);

        // Act
        const entries = await collect(ctx, treeId);

        // Assert
        expect(entries).toEqual([
          { path: 'top/sibling.txt' as FilePath, id: otherBlobId, mode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given a tree whose entry resolves — via readRawObject — back to itself', () => {
    describe('When walkRawSubtree walks it', () => {
      it('Then throws TREE_CYCLE_DETECTED with the offending id', async () => {
        // Arrange — a genuinely self-referential tree cannot exist on disk
        // (content-addressed hashing prevents it), so a real (empty) tree id
        // is intercepted at the read boundary and made to resolve to a tree
        // that loops back to it.
        const ctx = await buildSeededContext();
        const realTreeId = await writeTree(ctx, []);
        const loopEntry: ReadonlyArray<{
          readonly name: string;
          readonly mode: FileMode;
          readonly id: ObjectId;
        }> = [{ name: 'loop', mode: FILE_MODE.DIRECTORY, id: realTreeId }];
        const loopContent = serializeTreeContent(
          { type: 'tree', id: realTreeId, entries: loopEntry },
          SHA1_CONFIG,
        );
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) =>
            id === realTreeId
              ? { type: 'tree', content: loopContent, bytes: loopContent }
              : realReadRawObject(spyCtx, id, options),
          );
        // Act + Assert
        try {
          await collect(ctx, realTreeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; id: string } };
          expect(data.code).toBe('TREE_CYCLE_DETECTED');
          expect(data.id).toBe(realTreeId);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('Given maxDepth=1 and a two-level nested subtree', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with the offending depth (just-over)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const leafId = await writeTree(ctx, [
          { name: 'leaf', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const midId = await writeTree(ctx, [
          { name: 'mid', mode: FILE_MODE.DIRECTORY, id: leafId },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'root', mode: FILE_MODE.DIRECTORY, id: midId },
        ]);
        const bounds = { maxDepth: 1, maxEntries: DEFAULT_FLATTEN_BOUNDS.maxEntries };

        // Act + Assert
        try {
          await collect(ctx, rootId, bounds);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(2);
        }
      });
    });
  });

  describe('Given maxDepth=2 and a two-level nested subtree (at cap)', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then the subtree walks fully (pins the comparison direction: depth === cap succeeds)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const leafId = await writeTree(ctx, [
          { name: 'leaf', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const midId = await writeTree(ctx, [
          { name: 'mid', mode: FILE_MODE.DIRECTORY, id: leafId },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'root', mode: FILE_MODE.DIRECTORY, id: midId },
        ]);
        const bounds = { maxDepth: 2, maxEntries: DEFAULT_FLATTEN_BOUNDS.maxEntries };

        // Act
        const entries = await collect(ctx, rootId, bounds);

        // Assert
        expect(entries).toEqual([
          { path: 'top/root/mid/leaf' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given maxEntries=2 and a 3-entry subtree', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then throws TREE_ENTRY_LIMIT_EXCEEDED with the count and the limit (just-over)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'b', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'c', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const bounds = { maxDepth: DEFAULT_FLATTEN_BOUNDS.maxDepth, maxEntries: 2 };

        // Act + Assert
        try {
          await collect(ctx, treeId, bounds);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; count: number; limit: number } };
          expect(data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
          expect(data.count).toBe(3);
          expect(data.limit).toBe(2);
        }
      });
    });
  });

  describe('Given maxEntries=3 and a 3-entry subtree (at cap)', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then all entries are emitted', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'b', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'c', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const bounds = { maxDepth: DEFAULT_FLATTEN_BOUNDS.maxDepth, maxEntries: 3 };

        // Act
        const entries = await collect(ctx, treeId, bounds);

        // Assert
        expect(entries).toHaveLength(3);
      });
    });
  });

  describe('Given an aborted signal before walkRawSubtree starts', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then throws OPERATION_ABORTED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const controller = new AbortController();
        controller.abort();
        const aborted = { ...ctx, signal: controller.signal };

        // Act + Assert
        try {
          await collect(aborted, treeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string } };
          expect(data.code).toBe('OPERATION_ABORTED');
        }
      });
    });
  });
});
