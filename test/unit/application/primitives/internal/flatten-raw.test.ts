import { describe, expect, it, vi } from 'vitest';
import { MAX_CONCURRENT_OBJECT_LOADS } from '../../../../../src/application/primitives/internal/bounded-map.js';
import {
  DEFAULT_FLATTEN_BOUNDS,
  type FlattenBounds,
  flattenRawTree,
} from '../../../../../src/application/primitives/internal/flatten-raw.js';
import * as rawTreeIoMod from '../../../../../src/application/primitives/internal/raw-tree-io.js';
import * as readObjectMod from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { encode } from '../../../../../src/domain/objects/encoding.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  hexToBytes,
  type ObjectId,
  SHA1_CONFIG,
  serializeTreeContent,
} from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

async function writeBlob(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: string,
): Promise<ObjectId> {
  return writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });
}

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Hand-built raw entry bytes — planting a mode/name/oid combination
 *  `writeTree` itself would refuse, to pin the prescan/main-loop refusal
 *  ORDER rather than any single guard in isolation. */
function rawEntry(mode: string, name: string, id: ObjectId): Uint8Array {
  return concatBytes(encode(`${mode} ${name}\0`), hexToBytes(id));
}

/** A structurally truncated trailing entry — fewer oid bytes than the
 *  digest length. `writeTree` never has to build this: it must be planted
 *  directly in a level's raw content, ahead of the main loop's earlier
 *  guards, to prove which error fires FIRST. */
function truncatedEntry(mode: string, name: string, id: ObjectId, keepBytes: number): Uint8Array {
  return concatBytes(encode(`${mode} ${name}\0`), hexToBytes(id).subarray(0, keepBytes));
}

const LEAF_OID = 'a'.repeat(40) as ObjectId;
const WEIRD_MODE_OID = 'd'.repeat(40) as ObjectId;

/** Swap `readRawObject`'s response for `rootId` with hand-crafted, possibly
 *  malformed, raw content — the only way to get a level's OWN bytes past
 *  `writeTree`'s validation and into `flattenRawTree`'s root read. */
function stubRootContent(rootId: ObjectId, content: Uint8Array) {
  const realReadRawObject = readObjectMod.readRawObject;
  return vi
    .spyOn(readObjectMod, 'readRawObject')
    .mockImplementation(async (spyCtx, id, options) =>
      id === rootId
        ? { type: 'tree', content, bytes: content }
        : realReadRawObject(spyCtx, id, options),
    );
}

describe('flattenRawTree', () => {
  describe('Given maxEntries=2 and a 3-entry tree', () => {
    describe('When flattenRawTree runs', () => {
      it('Then throws TREE_ENTRY_LIMIT_EXCEEDED with the count and the limit (just-over)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'b', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'c', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const bounds: FlattenBounds = { maxDepth: 1024, maxEntries: 2 };
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, treeId, bounds);
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

  describe('Given maxEntries=3 and a 3-entry tree (at cap)', () => {
    describe('When flattenRawTree runs', () => {
      it('Then all entries are flattened', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'b', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'c', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const bounds: FlattenBounds = { maxDepth: 1024, maxEntries: 3 };
        const sut = flattenRawTree;

        // Act
        const result = await sut(ctx, treeId, bounds);

        // Assert
        expect(result.entries.size).toBe(3);
      });
    });
  });

  describe('Given maxEntries=1 and a tree whose first entry is a directory', () => {
    describe('When flattenRawTree runs', () => {
      it('Then the directory entry itself trips the cap, at the same count walkTree would', async () => {
        // Arrange — proves the counter increments for a directory entry, not
        // only for leaves: the (empty) subtree contributes no entries of its
        // own, so the second entry `b` is the one that observes the overflow.
        const ctx = await buildSeededContext();
        const emptySubtreeId = await writeTree(ctx, []);
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a', mode: FILE_MODE.DIRECTORY, id: emptySubtreeId },
          { name: 'b', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const bounds: FlattenBounds = { maxDepth: 1024, maxEntries: 1 };
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, treeId, bounds);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; count: number; limit: number } };
          expect(data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
          expect(data.count).toBe(2);
          expect(data.limit).toBe(1);
        }
      });
    });
  });

  describe('Given maxDepth=1 and a two-level nested tree', () => {
    describe('When flattenRawTree runs', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with the offending depth', async () => {
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
        const bounds: FlattenBounds = {
          maxDepth: 1,
          maxEntries: DEFAULT_FLATTEN_BOUNDS.maxEntries,
        };
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, rootId, bounds);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(2);
        }
      });
    });
  });

  describe('Given maxDepth=2 and a two-level nested tree (at cap)', () => {
    describe('When flattenRawTree runs', () => {
      it('Then the tree flattens fully (pins the comparison direction: depth === cap succeeds)', async () => {
        // Arrange — same shape as the maxDepth=1 failing case above, but the
        // cap now exactly matches the depth reached (2), proving the guard is
        // `depth > cap`, not `depth >= cap`.
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
        const bounds: FlattenBounds = {
          maxDepth: 2,
          maxEntries: DEFAULT_FLATTEN_BOUNDS.maxEntries,
        };
        const sut = flattenRawTree;

        // Act
        const result = await sut(ctx, rootId, bounds);

        // Assert
        expect(result.entries.size).toBe(1);
        expect(result.entries.get('root/mid/leaf' as FilePath)?.id).toBe(blobId);
      });
    });
  });

  describe('Given a tree whose entry resolves — via readRawObject — back to itself', () => {
    describe('When flattenRawTree walks it', () => {
      it('Then throws TREE_CYCLE_DETECTED with the offending id', async () => {
        // Arrange
        // Cryptographic hashes prevent a genuinely self-referential tree from
        // existing on disk, so a real (empty) tree id is intercepted at the
        // read boundary and made to resolve to a tree that loops back to it.
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
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, realTreeId, DEFAULT_FLATTEN_BOUNDS);
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

  describe('Given a signal that aborts between two sibling leaf entries', () => {
    describe('When flattenRawTree runs', () => {
      it('Then throws OPERATION_ABORTED before the second entry is ever read (the walk stops, not just throws)', async () => {
        // Arrange — the root tree's own read already runs its own (redundant)
        // abort check before flattenLevel ever starts, so a signal aborted from
        // the outset would never actually exercise this guard. Abort instead
        // from inside the FIRST entry's own path computation, so only this
        // per-entry guard can catch the SECOND entry — and prove the walk
        // stopped there (via the join-path call count) rather than merely
        // throwing after finishing the whole tree.
        const ctx = await buildSeededContext();
        const blobA = await writeBlob(ctx, 'a');
        const blobB = await writeBlob(ctx, 'b');
        const treeId = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobA },
          { name: 'b.txt', mode: FILE_MODE.REGULAR, id: blobB },
        ]);
        const controller = new AbortController();
        const aborted = { ...ctx, signal: controller.signal };
        const realJoinPath = rawTreeIoMod.joinPath;
        let calls = 0;
        const joinPathSpy = vi
          .spyOn(rawTreeIoMod, 'joinPath')
          .mockImplementation((prefix, name) => {
            calls += 1;
            if (calls === 1) controller.abort();
            return realJoinPath(prefix, name);
          });
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(aborted, treeId, DEFAULT_FLATTEN_BOUNDS);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string } };
          expect(data.code).toBe('OPERATION_ABORTED');
        } finally {
          // Only the first entry's path was ever computed.
          expect(joinPathSpy).toHaveBeenCalledTimes(1);
          joinPathSpy.mockRestore();
        }
      });
    });
  });

  describe('Given a signal that is present but never aborted', () => {
    describe('When flattenRawTree runs', () => {
      it('Then the tree flattens normally', async () => {
        // Arrange — a live, non-aborted signal must not trip the guard.
        const controller = new AbortController();
        const ctx = await buildSeededContext({ signal: controller.signal });
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const sut = flattenRawTree;

        // Act
        const result = await sut(ctx, treeId, DEFAULT_FLATTEN_BOUNDS);

        // Assert
        expect(result.entries.size).toBe(1);
      });
    });
  });

  describe('Given a root tree with more directory children than the concurrency bound', () => {
    describe('When flattenRawTree runs', () => {
      it('Then in-flight subtree reads peak at exactly the bound', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const width = MAX_CONCURRENT_OBJECT_LOADS + 8;
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
        const sut = flattenRawTree;

        // Act
        try {
          const result = await sut(ctx, rootId, DEFAULT_FLATTEN_BOUNDS);

          // Assert
          expect(result.entries.size).toBe(width);
          // width (bound + 8) sits under the prescan window (2x bound), so
          // every child is queued and the limiter alone decides the peak:
          // exactly the bound, not merely at-or-under it (which a
          // non-serialising bug of 2 or 3 in-flight would also satisfy).
          expect(maxInFlight).toBe(MAX_CONCURRENT_OBJECT_LOADS);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('Given a multi-level, multi-directory tree whose reads settle out of request order', () => {
    describe('When flattenRawTree runs', () => {
      it('Then the flattened Map is still populated in strict DFS pre-order', async () => {
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
        const sut = flattenRawTree;

        // Act
        try {
          const result = await sut(ctx, rootId, DEFAULT_FLATTEN_BOUNDS);

          // Assert
          expect([...result.entries.keys()]).toEqual([
            'a-dirA/1-leaf.txt',
            'a-dirA/2-inner/x.txt',
            'b-dirB/leaf.txt',
            'c-dirC/leaf.txt',
          ]);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('Given a cycle on the first sibling and a second sibling whose prefetch read rejects', () => {
    describe('When flattenRawTree runs', () => {
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
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, realTreeId, DEFAULT_FLATTEN_BOUNDS);
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

  // --- refusal-order faithfulness: the prescan must never run ahead of the main
  // loop's own, earlier per-entry guards (see internal/raw-subtree-prefetch.ts) ---

  describe('Given 3 valid leaf entries followed by a truncated one, with maxEntries capped below the valid count', () => {
    describe('When flattenRawTree runs', () => {
      it('Then throws TREE_ENTRY_LIMIT_EXCEEDED — the entry cap trips before the main loop ever reaches the truncated tail', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rootId = await writeTree(ctx, []);
        const content = concatBytes(
          rawEntry(FILE_MODE.REGULAR, 'a', LEAF_OID),
          rawEntry(FILE_MODE.REGULAR, 'b', LEAF_OID),
          rawEntry(FILE_MODE.REGULAR, 'c', LEAF_OID),
          truncatedEntry(FILE_MODE.REGULAR, 'd', LEAF_OID, 5),
        );
        const spy = stubRootContent(rootId, content);
        const bounds: FlattenBounds = { maxDepth: DEFAULT_FLATTEN_BOUNDS.maxDepth, maxEntries: 2 };
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, rootId, bounds);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; count: number; limit: number } };
          expect(data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
          expect(data.count).toBe(3);
          expect(data.limit).toBe(2);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('Given an aborted signal and a level whose first entry is valid but whose second is truncated', () => {
    describe('When flattenRawTree runs', () => {
      it('Then throws OPERATION_ABORTED — the abort guard trips on entry 1, before the truncated entry 2 is ever scanned', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rootId = await writeTree(ctx, []);
        const content = concatBytes(
          rawEntry(FILE_MODE.REGULAR, 'a', LEAF_OID),
          truncatedEntry(FILE_MODE.REGULAR, 'b', LEAF_OID, 5),
        );
        const spy = stubRootContent(rootId, content);
        const controller = new AbortController();
        controller.abort();
        const aborted = { ...ctx, signal: controller.signal };
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(aborted, rootId, DEFAULT_FLATTEN_BOUNDS);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string } };
          expect(data.code).toBe('OPERATION_ABORTED');
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('Given an early entry named ".." and a later truncated entry', () => {
    describe('When flattenRawTree runs', () => {
      it("Then throws the name refusal at offset 0 — flatten's own name validation trips before the truncated tail is ever scanned", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rootId = await writeTree(ctx, []);
        const content = concatBytes(
          rawEntry(FILE_MODE.REGULAR, '..', LEAF_OID),
          truncatedEntry(FILE_MODE.REGULAR, 'b', LEAF_OID, 5),
        );
        const spy = stubRootContent(rootId, content);
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, rootId, DEFAULT_FLATTEN_BOUNDS);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; offset: number; reason: string } };
          expect(data.code).toBe('INVALID_TREE_ENTRY');
          expect(data.offset).toBe(0);
          expect(data.reason).toBe('invalid entry name: ..');
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('Given an early entry with a directory-shaped but unrecognised mode (47777) and a later truncated entry', () => {
    describe('When flattenRawTree runs', () => {
      it('Then throws INVALID_FILE_MODE for the first entry — the mode refusal trips before the truncated tail is ever scanned', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rootId = await writeTree(ctx, []);
        const content = concatBytes(
          rawEntry('47777', 'a', WEIRD_MODE_OID),
          truncatedEntry(FILE_MODE.REGULAR, 'b', LEAF_OID, 5),
        );
        const spy = stubRootContent(rootId, content);
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, rootId, DEFAULT_FLATTEN_BOUNDS);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; value: string } };
          expect(data.code).toBe('INVALID_FILE_MODE');
          expect(data.value).toBe('47777');
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('Given a level entered with only 1 entry left in the budget, and that level has 3 directory children', () => {
    describe('When flattenRawTree runs', () => {
      it('Then speculative child reads never exceed the remaining budget, and the walk still throws TREE_ENTRY_LIMIT_EXCEEDED', async () => {
        // Arrange — maxEntries=2: the root's own 'd' entry consumes 1, so by
        // the time flattenLevel enters 'd's content (3 directory
        // grandchildren) the remaining budget is maxEntries - counter.value
        // = 1. A mutant flipping that `-` to `+` opens the window to
        // maxEntries + counter.value (3) instead, prefetching all 3
        // grandchildren regardless of the 1-entry budget — wasted I/O that,
        // on a partial clone, would reach a promisor fetch for an object the
        // walk was never going to need.
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
        const bounds: FlattenBounds = { maxDepth: DEFAULT_FLATTEN_BOUNDS.maxDepth, maxEntries: 2 };
        const remainingBudgetAtChildLevel = 1;
        let speculativeReadCount = 0;
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) => {
            if (grandchildIds.has(id)) speculativeReadCount += 1;
            return realReadRawObject(spyCtx, id, options);
          });
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, rootId, bounds);
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
});
