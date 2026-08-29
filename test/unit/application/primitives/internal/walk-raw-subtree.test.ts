import { describe, expect, it, vi } from 'vitest';
import type { FlattenBounds } from '../../../../../src/application/primitives/internal/flatten-raw.js';
import {
  type Counter,
  type RawSubtreeEntry,
  walkRawSubtree,
} from '../../../../../src/application/primitives/internal/walk-raw-subtree.js';
import * as readObjectMod from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import {
  DEFAULT_MAX_TREE_DEPTH,
  MAX_FLAT_TREE_ENTRIES,
} from '../../../../../src/domain/diff/flat-tree.js';
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

/** A generously large bounds pair for tests that are not themselves
 *  exercising the depth or entry cap — mirrors the shape a resolved
 *  `resolveFlattenBounds(ctx)` call would produce for an unconfigured
 *  repository. */
const TEST_BOUNDS: FlattenBounds = {
  maxDepth: DEFAULT_MAX_TREE_DEPTH,
  maxEntries: MAX_FLAT_TREE_ENTRIES,
};

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
  bounds = TEST_BOUNDS,
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
        const bounds = { maxDepth: 1, maxEntries: TEST_BOUNDS.maxEntries };

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
        const bounds = { maxDepth: 2, maxEntries: TEST_BOUNDS.maxEntries };

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
        const bounds = { maxDepth: TEST_BOUNDS.maxDepth, maxEntries: 2 };

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
        const bounds = { maxDepth: TEST_BOUNDS.maxDepth, maxEntries: 3 };

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

  describe('Given a signal that aborts between two sibling leaf entries', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then throws OPERATION_ABORTED before the second entry is ever emitted (the walk stops, not just throws)', async () => {
        // Arrange — root reads its own (redundant) abort check before the walk
        // even starts, so aborting up front (as the sibling test above does)
        // never reaches this per-entry guard. Abort instead from inside the
        // `emit` callback for the FIRST entry — no other read happens between
        // two sibling leaves, so only this guard can catch the second one.
        const ctx = await buildSeededContext();
        const blobA = await writeBlob(ctx, 'a');
        const blobB = await writeBlob(ctx, 'b');
        const treeId = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobA },
          { name: 'b.txt', mode: FILE_MODE.REGULAR, id: blobB },
        ]);
        const controller = new AbortController();
        const aborted = { ...ctx, signal: controller.signal };
        const emitted: RawSubtreeEntry[] = [];
        const sut = walkRawSubtree;

        // Act + Assert
        try {
          await sut(aborted, treeId, TEST_BOUNDS, 'top', { value: 0 }, (entry) => {
            emitted.push(entry);
            controller.abort();
          });
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string } };
          expect(data.code).toBe('OPERATION_ABORTED');
        } finally {
          // Only the first entry was ever emitted — the walk stopped.
          expect(emitted).toHaveLength(1);
        }
      });
    });
  });

  describe('Given a signal that is present but never aborted', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then all entries are emitted normally', async () => {
        // Arrange — a live, non-aborted signal must not trip the guard.
        const controller = new AbortController();
        const ctx = await buildSeededContext({ signal: controller.signal });
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobId },
        ]);

        // Act
        const entries = await collect(ctx, treeId);

        // Assert
        expect(entries).toHaveLength(1);
      });
    });
  });

  describe('Given a root subtree with more directory children than the concurrency bound', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then in-flight subtree reads peak at exactly the bound', async () => {
        // Arrange — an explicit ioBound distinct from cpuBound so a bucket-swap
        // regression (deriving the limiter from the wrong bucket) fails loudly.
        const ioBound = 6;
        const ctx: Ctx = {
          ...(await buildSeededContext()),
          concurrency: { cpuBound: 1, ioBound },
        };
        const width = ioBound + 8;
        const dirEntries: Array<{ name: string; mode: FileMode; id: ObjectId }> = [];
        const subtreeIds = new Set<ObjectId>();
        for (let i = 0; i < width; i++) {
          const blobId = await writeBlob(ctx, `content-${i}`);
          const subtreeId = await writeTree(ctx, [
            { name: 'f', mode: FILE_MODE.REGULAR, id: blobId },
          ]);
          subtreeIds.add(subtreeId);
          dirEntries.push({
            name: `d${String(i).padStart(3, '0')}`,
            mode: FILE_MODE.DIRECTORY,
            id: subtreeId,
          });
        }
        const rootId = await writeTree(ctx, dirEntries);
        let inFlight = 0;
        let maxInFlight = 0;
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) => {
            if (!subtreeIds.has(id)) return realReadRawObject(spyCtx, id, options);
            inFlight += 1;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await Promise.resolve();
            inFlight -= 1;
            return realReadRawObject(spyCtx, id, options);
          });

        // Act
        try {
          const entries = await collect(ctx, rootId);

          // Assert
          expect(entries).toHaveLength(width);
          // width (bound + 8) sits under the prescan window (2x bound), so
          // every child is queued and the limiter alone decides the peak:
          // exactly the bound, not merely at-or-under it (which a
          // non-serialising bug of 2 or 3 in-flight would also satisfy).
          expect(maxInFlight).toBe(ioBound);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('Given a multi-level, multi-directory subtree whose reads settle out of request order', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then entries are still emitted in strict DFS pre-order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const leafA = await writeBlob(ctx, 'a');
        const leafAI = await writeBlob(ctx, 'ai');
        const leafB = await writeBlob(ctx, 'b');
        const leafC = await writeBlob(ctx, 'c');
        const innerId = await writeTree(ctx, [
          { name: 'x.txt', mode: FILE_MODE.REGULAR, id: leafAI },
        ]);
        const dirAId = await writeTree(ctx, [
          { name: '1-leaf.txt', mode: FILE_MODE.REGULAR, id: leafA },
          { name: '2-inner', mode: FILE_MODE.DIRECTORY, id: innerId },
        ]);
        const dirBId = await writeTree(ctx, [
          { name: 'leaf.txt', mode: FILE_MODE.REGULAR, id: leafB },
        ]);
        const dirCId = await writeTree(ctx, [
          { name: 'leaf.txt', mode: FILE_MODE.REGULAR, id: leafC },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'a-dirA', mode: FILE_MODE.DIRECTORY, id: dirAId },
          { name: 'b-dirB', mode: FILE_MODE.DIRECTORY, id: dirBId },
          { name: 'c-dirC', mode: FILE_MODE.DIRECTORY, id: dirCId },
        ]);
        // dirA is requested first but settles LAST; dirC is requested last but
        // settles FIRST — proves emission order tracks the entry loop, not
        // read-completion order.
        const extraTicks = new Map<ObjectId, number>([
          [dirAId, 3],
          [dirBId, 2],
          [dirCId, 1],
        ]);
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) => {
            const ticks = extraTicks.get(id);
            if (ticks !== undefined) {
              for (let i = 0; i < ticks; i++) await Promise.resolve();
            }
            return realReadRawObject(spyCtx, id, options);
          });

        // Act
        try {
          const entries = await collect(ctx, rootId);

          // Assert
          expect(entries.map((entry) => entry.path)).toEqual([
            'top/a-dirA/1-leaf.txt',
            'top/a-dirA/2-inner/x.txt',
            'top/b-dirB/leaf.txt',
            'top/c-dirC/leaf.txt',
          ]);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('Given a cycle on the first sibling and a second sibling whose prefetch read rejects', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then the cycle error surfaces and the second sibling never produces an unhandled rejection', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const realTreeId = await writeTree(ctx, []);
        const failingSubtreeId = await writeTree(ctx, []);
        const loopEntries: ReadonlyArray<{
          readonly name: string;
          readonly mode: FileMode;
          readonly id: ObjectId;
        }> = [
          { name: 'aaa-loop', mode: FILE_MODE.DIRECTORY, id: realTreeId },
          { name: 'zzz-other', mode: FILE_MODE.DIRECTORY, id: failingSubtreeId },
        ];
        const loopContent = serializeTreeContent(
          { type: 'tree', id: realTreeId, entries: loopEntries },
          SHA1_CONFIG,
        );
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) => {
            if (id === realTreeId)
              return { type: 'tree', content: loopContent, bytes: loopContent };
            if (id === failingSubtreeId) throw new Error('simulated read failure');
            return realReadRawObject(spyCtx, id, options);
          });
        const unhandled: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
          unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);

        // Act + Assert
        try {
          await collect(ctx, realTreeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; id: string } };
          expect(data.code).toBe('TREE_CYCLE_DETECTED');
          expect(data.id).toBe(realTreeId);
        } finally {
          await new Promise<void>((resolve) => setImmediate(resolve));
          try {
            expect(unhandled).toEqual([]);
          } finally {
            process.off('unhandledRejection', onUnhandledRejection);
            spy.mockRestore();
          }
        }
      });
    });
  });

  describe('Given a level entered with only 1 entry left in the budget, and that level has 3 directory children', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then speculative child reads never exceed the remaining budget, and the walk still throws TREE_ENTRY_LIMIT_EXCEEDED', async () => {
        // Arrange — maxEntries=2: the root's own 'd' entry consumes 1, so by
        // the time walkLevel enters 'd's content (3 directory grandchildren)
        // the remaining budget is maxEntries - counter.value = 1. A mutant
        // flipping that `-` to `+` opens the window to maxEntries +
        // counter.value (3) instead, prefetching all 3 grandchildren
        // regardless of the 1-entry budget — wasted I/O that, on a partial
        // clone, would reach a promisor fetch for an object the walk was
        // never going to need.
        const ctx = await buildSeededContext();
        const mkTinyDir = async (label: string): Promise<ObjectId> => {
          const blobId = await writeBlob(ctx, label);
          return writeTree(ctx, [{ name: 'x', mode: FILE_MODE.REGULAR, id: blobId }]);
        };
        const g0 = await mkTinyDir('g0');
        const g1 = await mkTinyDir('g1');
        const g2 = await mkTinyDir('g2');
        const grandchildIds = new Set<ObjectId>([g0, g1, g2]);
        const childLevelId = await writeTree(ctx, [
          { name: 'g0', mode: FILE_MODE.DIRECTORY, id: g0 },
          { name: 'g1', mode: FILE_MODE.DIRECTORY, id: g1 },
          { name: 'g2', mode: FILE_MODE.DIRECTORY, id: g2 },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'd', mode: FILE_MODE.DIRECTORY, id: childLevelId },
        ]);
        const bounds = { maxDepth: TEST_BOUNDS.maxDepth, maxEntries: 2 };
        const remainingBudgetAtChildLevel = 1;
        let speculativeReadCount = 0;
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) => {
            if (grandchildIds.has(id)) speculativeReadCount += 1;
            return realReadRawObject(spyCtx, id, options);
          });

        // Act + Assert
        try {
          await collect(ctx, rootId, bounds);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; count: number; limit: number } };
          expect(data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
          expect(data.count).toBe(3);
          expect(data.limit).toBe(2);
        } finally {
          await new Promise<void>((resolve) => setImmediate(resolve));
          try {
            expect(speculativeReadCount).toBeLessThanOrEqual(remainingBudgetAtChildLevel);
          } finally {
            spy.mockRestore();
          }
        }
      });
    });
  });
  describe('Given two sibling directories sharing one subtree oid', () => {
    describe('When walkRawSubtree runs', () => {
      it('Then both branches emit, with no false TREE_CYCLE_DETECTED', async () => {
        // Arrange — the cycle guard tracks the root-to-current path, so an oid
        // must be removed from it when its level returns. Without that removal
        // the second sibling reads as a repeat visit and falsely refuses.
        const ctx = await buildSeededContext();
        const leaf = await writeBlob(ctx, 'shared');
        const sharedId = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: leaf },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'x', mode: FILE_MODE.DIRECTORY, id: sharedId },
          { name: 'y', mode: FILE_MODE.DIRECTORY, id: sharedId },
        ]);

        // Act
        const entries = await collect(ctx, rootId);

        // Assert
        const paths = entries.map((entry) => entry.path);
        expect(paths).toContain('top/x/f.txt');
        expect(paths).toContain('top/y/f.txt');
      });
    });
  });
});
