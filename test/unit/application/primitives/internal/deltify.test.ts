import { describe, expect, it, vi } from 'vitest';
import {
  type DeltifiedEntry,
  deltifyEntries,
} from '../../../../../src/application/primitives/internal/deltify.js';
import { readRawObject } from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import type { Blob, FileMode, ObjectId } from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import * as deltaEncodeModule from '../../../../../src/domain/storage/delta-encode.js';
import type { DeltaPolicy } from '../../../../../src/domain/storage/delta-policy.js';
import { PACK_ENTRY_TYPE } from '../../../../../src/domain/storage/pack-entry.js';
import { buildSeededContext } from '../fixtures.js';

/** A pure function of (seed, index) — never a stateful generator — so two
 *  calls with the same seed and different lengths always agree on their
 *  common prefix, which is exactly what a COPY-friendly fixture needs. */
function pseudoRandomByte(seed: number, index: number): number {
  const h = Math.imul(seed ^ index, 0x9e3779b1) ^ (index << 13);
  return (Math.imul(h, 0x85ebca6b) >>> 24) & 0xff;
}

function pseudoRandomBytes(seed: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_unused, i) => pseudoRandomByte(seed, i));
}

const DEFAULT_POLICY: DeltaPolicy = {
  enabled: true,
  window: 10,
  maxDepth: 50,
  windowMemoryBudget: 0,
};

async function writeBlob(ctx: Awaited<ReturnType<typeof buildSeededContext>>, content: Uint8Array) {
  const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
  return writeObject(ctx, blob);
}

function findEntry(results: ReadonlyArray<DeltifiedEntry>, id: ObjectId): DeltifiedEntry {
  const found = results.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no result for ${id}`);
  return found;
}

/** Walks OFS_DELTA baseIndex hops back to a base entry, counting hops. */
function chainDepthOf(results: ReadonlyArray<DeltifiedEntry>, index: number): number {
  const entry = results[index]!.entry;
  if (entry.type !== PACK_ENTRY_TYPE.OFS_DELTA) return 0;
  return 1 + chainDepthOf(results, entry.baseIndex);
}

describe('deltifyEntries', () => {
  describe('Given two near-identical blobs sharing a large high-entropy prefix', () => {
    describe('When deltifyEntries runs', () => {
      it('Then at least one entry is an OFS_DELTA whose base is a strictly earlier emission index', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(1, 300);
        const idA = await writeBlob(ctx, shared);
        const idB = await writeBlob(ctx, Uint8Array.from([...shared, 0x01]));
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idA, idB], DEFAULT_POLICY);

        // Assert
        const deltas = result.filter((r) => r.entry.type === PACK_ENTRY_TYPE.OFS_DELTA);
        expect(deltas.length).toBeGreaterThanOrEqual(1);
        const deltaIndex = result.findIndex((r) => r.entry.type === PACK_ENTRY_TYPE.OFS_DELTA);
        const baseIndex = (result[deltaIndex]!.entry as { baseIndex: number }).baseIndex;
        expect(baseIndex).toBeLessThan(deltaIndex);
      });
    });
  });

  describe('Given a corpus of incompressible, mutually unrelated blobs', () => {
    describe('When deltifyEntries runs', () => {
      it('Then zero OFS_DELTA entries are emitted', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, pseudoRandomBytes(11, 64));
        const idB = await writeBlob(ctx, pseudoRandomBytes(22, 64));
        const idC = await writeBlob(ctx, pseudoRandomBytes(33, 64));
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idA, idB, idC], DEFAULT_POLICY);

        // Assert
        const deltas = result.filter((r) => r.entry.type === PACK_ENTRY_TYPE.OFS_DELTA);
        expect(deltas).toHaveLength(0);
      });
    });
  });

  describe('Given policy.window = 1 and four objects that would all delta cleanly against a predecessor', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the search engine is invoked at most once per object (one candidate)', async () => {
        // Arrange — each object is a strict prefix of the previous one, so DESC-size
        // sort visits them in construction order and every one but the first has
        // exactly one member available in a window of size 1.
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(2, 200);
        const ids = [
          await writeBlob(ctx, shared.slice(0, 200)),
          await writeBlob(ctx, shared.slice(0, 150)),
          await writeBlob(ctx, shared.slice(0, 100)),
          await writeBlob(ctx, shared.slice(0, 50)),
        ];
        const policy: DeltaPolicy = {
          enabled: true,
          window: 1,
          maxDepth: 50,
          windowMemoryBudget: 0,
        };
        const spy = vi.spyOn(deltaEncodeModule, 'encodeDeltaFromIndex');
        const sut = deltifyEntries;

        // Act
        await sut(ctx, ids, policy);

        // Assert — first object has an empty window (0 calls); each of the
        // remaining three sees exactly one window member (1 call each).
        expect(spy).toHaveBeenCalledTimes(3);
        spy.mockRestore();
      });
    });
  });

  describe('Given a chain-forcing corpus and a policy capping depth at 3', () => {
    describe('When deltifyEntries runs', () => {
      it('Then no emitted chain is longer than policy.maxDepth', async () => {
        // Arrange — window=1 forces a straight chain off the sole predecessor;
        // once a candidate's own chainDepth reaches the cap it is excluded, so
        // the chain resets to a fresh base and grows again (sawtooth).
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(3, 500);
        const ids: ObjectId[] = [];
        for (let k = 0; k < 8; k += 1) {
          ids.push(await writeBlob(ctx, shared.slice(0, 500 - k)));
        }
        const policy: DeltaPolicy = {
          enabled: true,
          window: 1,
          maxDepth: 3,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, ids, policy);

        // Assert
        for (let i = 0; i < result.length; i += 1) {
          expect(chainDepthOf(result, i)).toBeLessThanOrEqual(policy.maxDepth);
        }
        // At least one delta chain actually reaches the cap, proving the
        // corpus was chain-forcing rather than trivially shallow.
        expect(Math.max(...result.map((_r, i) => chainDepthOf(result, i)))).toBe(3);
      });
    });
  });

  describe('Given an object larger than the whole windowMemory budget', () => {
    describe('When deltifyEntries runs', () => {
      it('Then it is never admitted to the window and never becomes a base', async () => {
        // Arrange — objBig shares the same 200-byte prefix as objSmall, so if
        // objBig were (wrongly) admitted, objSmall would delta against it.
        // objBig's own content (400B) exceeds the 250B budget.
        const ctx = await buildSeededContext();
        const sharedPrefix = pseudoRandomBytes(4, 200);
        const bigTail = pseudoRandomBytes(5, 200);
        const idBig = await writeBlob(ctx, Uint8Array.from([...sharedPrefix, ...bigTail]));
        const idSmall = await writeBlob(ctx, Uint8Array.from([...sharedPrefix, 0x42]));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: 250,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idBig, idSmall], policy);

        // Assert — objBig is processed first (larger), window starts empty so
        // it is a base regardless; objSmall, processed second, would have
        // matched objBig's shared prefix had it been admitted — it did not.
        expect(findEntry(result, idBig).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(result, idSmall).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe("Given a budget one byte above an object's content length but below content-plus-index", () => {
    describe('When deltifyEntries runs', () => {
      it('Then the object is refused — the old content-only accounting would have wrongly admitted it', async () => {
        // Arrange — the old accounting charged only content.length, so a
        // budget of content.length + 1 would have admitted objBig. Charging
        // the built DeltaIndex too (heads + next) pushes the true weight
        // past that same budget, so objBig must now be refused. objSmall
        // shares objBig's prefix, so a wrong admission would be observable
        // as a delta match.
        const ctx = await buildSeededContext();
        const sharedPrefix = pseudoRandomBytes(6, 200);
        const bigTail = pseudoRandomBytes(7, 72);
        const bigContent = Uint8Array.from([...sharedPrefix, ...bigTail]);
        const idBig = await writeBlob(ctx, bigContent);
        const idSmall = await writeBlob(ctx, Uint8Array.from([...sharedPrefix, 0x42]));
        const index = deltaEncodeModule.createDeltaIndex(bigContent);
        const indexBytes = index.heads.byteLength + index.next.byteLength;
        // Sanity: the scenario is only meaningful when charging the index
        // actually costs something — otherwise old and new accounting agree
        // trivially and the test would pass for the wrong reason.
        expect(indexBytes).toBeGreaterThan(0);
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: bigContent.length + 1,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idBig, idSmall], policy);

        // Assert — idBig itself is still emitted as a base (its own window
        // was empty when it was processed); idSmall's failure to delta
        // against it is what proves idBig was never admitted to the window.
        expect(findEntry(result, idBig).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(result, idSmall).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given a budget that fits two of three objects, once each one is charged for its content AND its built DeltaIndex', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the oldest resident is evicted first', async () => {
        // Arrange — obj1(60B) and obj2(50B) together fit the budget, charging
        // each one's content length PLUS its DeltaIndex (heads + next) —
        // the same total admitToWindow now applies. Admitting obj3(42B)
        // forces eviction, and obj1 (oldest) goes first. probe1 shares
        // obj1's pattern and must fail to find a candidate (its base was
        // evicted); probe2 shares obj2's pattern and must succeed (its base
        // survives).
        const ctx = await buildSeededContext();
        const r1 = pseudoRandomBytes(101, 60);
        const r2 = pseudoRandomBytes(202, 50);
        const r3 = pseudoRandomBytes(303, 42);
        const id1 = await writeBlob(ctx, r1);
        const id2 = await writeBlob(ctx, r2);
        const id3 = await writeBlob(ctx, r3);
        const idProbe2 = await writeBlob(ctx, r2.slice(0, 32));
        const idProbe1 = await writeBlob(ctx, r1.slice(0, 30));
        const chargedWeight = (content: Uint8Array): number => {
          const index = deltaEncodeModule.createDeltaIndex(content);
          return content.length + index.heads.byteLength + index.next.byteLength;
        };
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: chargedWeight(r1) + chargedWeight(r2),
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [id1, id2, id3, idProbe2, idProbe1], policy);

        // Assert
        expect(findEntry(result, idProbe1).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(result, idProbe2).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given an empty oid list', () => {
    describe('When deltifyEntries runs', () => {
      it('Then it resolves with an empty array', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [], DEFAULT_POLICY);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a single oid', () => {
    describe('When deltifyEntries runs', () => {
      it('Then it emits exactly one base entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, pseudoRandomBytes(6, 40));
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [id], DEFAULT_POLICY);

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.entry.type).toBe(PACK_ENTRY_TYPE.BLOB);
      });
    });
  });

  describe('Given a mix of a deltifiable pair and an unrelated object', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the two-deflate acceptance rule runs only for the object that won a search', async () => {
        // Arrange — obj1 (base, empty window: 1 deflate call). obj2 shares
        // obj1's prefix (candidate found: 2 deflate calls). obj3 is unrelated
        // (no candidate found: 1 deflate call). Total: 4.
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(7, 60);
        const id1 = await writeBlob(ctx, shared);
        const id2 = await writeBlob(ctx, shared.slice(0, 59));
        const id3 = await writeBlob(ctx, pseudoRandomBytes(8, 20));
        const deflateSpy = vi.fn(ctx.compressor.deflate);
        const wrappedCtx = { ...ctx, compressor: { ...ctx.compressor, deflate: deflateSpy } };
        const sut = deltifyEntries;

        // Act
        await sut(wrappedCtx, [id1, id2, id3], DEFAULT_POLICY);

        // Assert
        expect(deflateSpy).toHaveBeenCalledTimes(4);
      });
    });
  });

  describe('Given a blob and a tree whose raw stored content bytes are identical', () => {
    describe('When deltifyEntries runs', () => {
      it('Then no delta is emitted across the type boundary despite byte-identical content', async () => {
        // Arrange — proves the type guard alone blocks the match: were it
        // absent, byte-identical content would trivially win a search.
        const ctx = await buildSeededContext();
        const leafBlobId = await writeBlob(ctx, new Uint8Array([9]));
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'a.bin', leafBlobId)]);
        const treeRaw = await readRawObject(ctx, treeId);
        const twinBlobId = await writeBlob(ctx, treeRaw.content);
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [treeId, twinBlobId], DEFAULT_POLICY);

        // Assert
        expect(findEntry(result, treeId).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(result, twinBlobId).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });
});
