import { describe, expect, it, vi } from 'vitest';
import {
  type DeltifiedEntry,
  deltifyEntries,
  searchBound,
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
        const result = await sut(
          ctx,
          [idA, idB].map((id) => ({ id })),
          DEFAULT_POLICY,
        );

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
        const result = await sut(
          ctx,
          [idA, idB, idC].map((id) => ({ id })),
          DEFAULT_POLICY,
        );

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
        await sut(
          ctx,
          ids.map((id) => ({ id })),
          policy,
        );

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
        const result = await sut(
          ctx,
          ids.map((id) => ({ id })),
          policy,
        );

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

  describe('Given a candidate that wins the raw search bound but ties the base on deflated size', () => {
    describe('When deltifyEntries runs', () => {
      it('Then it is emitted as a base entry, not a delta, and a later object still deltas against it starting a fresh chain', async () => {
        // Arrange — idBase and idLoser share an 1800-byte repeat run: the
        // COPY-encoded delta (raw ~278B) comfortably beats the 1000B search
        // bound, but the shared run compresses just as well standalone as it
        // does via COPY reference, so the deflated delta (233B) ties the
        // deflated content (233B) exactly — only the OFS_DELTA back-pointer
        // overhead separates them, and that alone tips acceptsDeltaEntry to
        // reject. idFollower is an exact 1999-byte prefix of idLoser's own
        // content, so it deltas cleanly against idLoser once idLoser is a
        // window member. maxDepth: 1 makes the reset load-bearing: idBase's
        // own chainDepth is 0, so a rejected idLoser candidate inherits a
        // candidate.chainDepth of 0 too — a fallback that forgot to reset
        // (kept candidate.chainDepth instead of a literal 0) would coincide
        // here, but a fallback that instead reused the accept-path's
        // `candidate.chainDepth + 1` (1) would push idLoser's chainDepth to
        // the cap, making tryCandidate refuse idFollower outright.
        const ctx = await buildSeededContext();
        const sharedRun = new Uint8Array(1800).fill(0x41);
        const entropyTail = pseudoRandomBytes(42, 200);
        const baseContent = Uint8Array.from([...sharedRun, ...new Uint8Array(201).fill(0x42)]);
        const loserContent = Uint8Array.from([...sharedRun, ...entropyTail]);
        const followerContent = Uint8Array.from([...sharedRun, ...entropyTail.slice(0, 199)]);
        const idBase = await writeBlob(ctx, baseContent);
        const idLoser = await writeBlob(ctx, loserContent);
        const idFollower = await writeBlob(ctx, followerContent);
        const policy: DeltaPolicy = {
          enabled: true,
          window: 1,
          maxDepth: 1,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idBase, idLoser, idFollower].map((id) => ({ id })),
          policy,
        );

        // Assert
        expect(findEntry(result, idLoser).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(result, idFollower).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        const followerIndex = result.findIndex((r) => r.id === idFollower);
        expect(chainDepthOf(result, followerIndex)).toBe(1);
      });
    });
  });

  describe('Given two window members whose raw (pre-deflate) deltas against a later object tie exactly in length, one strictly shallower than the other', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the same-size rule lets the strictly shallower member displace the incumbent despite the tie', async () => {
        // Arrange — idMember1(2000B) and idMember2(1999B) share the same
        // 1800B high-entropy run; idMember1 is admitted first (older),
        // idMember2 second (newer, and itself a delta off idMember1, so its
        // own chainDepth is 1). Both produce a byte-length-identical raw
        // delta against idTarget: same COPY match (offset 0, length 1800)
        // and the same INSERT tail (idTarget's own bytes — a base's own
        // tail, present or absent from the match, is irrelevant; only the
        // shared prefix is ever matched). Visit order tries idMember2
        // (more recent) first, setting the incumbent; idMember1, tried
        // second, ties it on length but is strictly shallower (chainDepth 0
        // vs 1) — git's same-size rule lets a strictly shallower base win a
        // tie, so idMember1 displaces idMember2 as the base idTarget deltas
        // against.
        const ctx = await buildSeededContext();
        const sharedRun = pseudoRandomBytes(600, 1800);
        const tailMember1 = pseudoRandomBytes(601, 200);
        const tailMember2 = pseudoRandomBytes(602, 199);
        const tailTarget = pseudoRandomBytes(603, 50);
        const member1Content = Uint8Array.from([...sharedRun, ...tailMember1]);
        const member2Content = Uint8Array.from([...sharedRun, ...tailMember2]);
        const targetContent = Uint8Array.from([...sharedRun, ...tailTarget]);
        const idMember1 = await writeBlob(ctx, member1Content);
        const idMember2 = await writeBlob(ctx, member2Content);
        const idTarget = await writeBlob(ctx, targetContent);
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idMember1, idMember2, idTarget].map((id) => ({ id })),
          policy,
        );

        // Assert — chainDepth 1 only holds if idTarget based directly off
        // idMember1 (chainDepth 0); a tie wrongly kept on the incumbent
        // would base idTarget off idMember2 instead, giving chainDepth 2.
        const targetIndex = result.findIndex((r) => r.id === idTarget);
        expect(chainDepthOf(result, targetIndex)).toBe(1);
      });
    });
  });

  describe('Given a window whose most-recently-admitted member wins a search and an older member fails it', () => {
    describe('When deltifyEntries runs', () => {
      it("Then the older member's failed search leaves the winning candidate untouched", async () => {
        // Arrange — idMember1 (unrelated random content, admitted
        // first/older) can never produce a delta for idTarget (no 16+ byte
        // run matches anywhere); idMember2 (shares idTarget's exact prefix,
        // admitted second/newer) wins outright. Search visits
        // most-recent-first, so idMember2's win must survive idMember1's
        // later, failed attempt.
        const ctx = await buildSeededContext();
        const unrelatedContent = pseudoRandomBytes(701, 400);
        const sharedContent = pseudoRandomBytes(702, 300);
        const idMember1 = await writeBlob(ctx, unrelatedContent);
        const idMember2 = await writeBlob(ctx, sharedContent);
        const idTarget = await writeBlob(ctx, sharedContent.slice(0, 250));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idMember1, idMember2, idTarget].map((id) => ({ id })),
          policy,
        );

        // Assert
        expect(findEntry(result, idTarget).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
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
        const result = await sut(
          ctx,
          [idBig, idSmall].map((id) => ({ id })),
          policy,
        );

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
        const result = await sut(
          ctx,
          [idBig, idSmall].map((id) => ({ id })),
          policy,
        );

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
        const result = await sut(
          ctx,
          [id1, id2, id3, idProbe2, idProbe1].map((id) => ({ id })),
          policy,
        );

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
        const result = await sut(
          ctx,
          [id].map((id) => ({ id })),
          DEFAULT_POLICY,
        );

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
        // (no candidate found: 1 deflate call). Total: 4. obj3 is sized at 50
        // bytes, not fewer — below 40 bytes sha1's own search-bound budget
        // (floor(size / 2) - 20) goes negative and wraps to unbounded, which
        // would let a full-literal delta through the search regardless of
        // how unrelated the content is, and this test is specifically about
        // a search that finds nothing.
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(7, 60);
        const id1 = await writeBlob(ctx, shared);
        const id2 = await writeBlob(ctx, shared.slice(0, 59));
        const id3 = await writeBlob(ctx, pseudoRandomBytes(8, 50));
        const deflateSpy = vi.fn(ctx.compressor.deflate);
        const wrappedCtx = { ...ctx, compressor: { ...ctx.compressor, deflate: deflateSpy } };
        const sut = deltifyEntries;

        // Act
        await sut(
          wrappedCtx,
          [id1, id2, id3].map((id) => ({ id })),
          DEFAULT_POLICY,
        );

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
        const result = await sut(
          ctx,
          [treeId, twinBlobId].map((id) => ({ id })),
          DEFAULT_POLICY,
        );

        // Assert
        expect(findEntry(result, treeId).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(result, twinBlobId).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given a 51-byte tail-flip pair and a 52-byte tail-flip pair, each producing the same 6-byte raw delta', () => {
    describe('When deltifyEntries runs under sha1', () => {
      it('Then the 51-byte target is refused (bound 5) and the 52-byte target is accepted (bound 6, inclusive)', async () => {
        // Arrange — floor(size / 2) - 20 (sha1's digest length) gives bound 5
        // at 51 bytes and 6 at 52; a base sharing every byte but the last with
        // its target always encodes to the same 6-byte COPY+INSERT delta
        // regardless of the base's own (larger) size, so 51 exercises the `<`
        // refusal and 52 the `<=` acceptance — the inclusive-bound killer.
        // Bases are padded past their target's own size so DESC-size
        // emission order admits them to the window first, independent of
        // content-addressed id ordering.
        const ctx = await buildSeededContext();
        const prefix51 = pseudoRandomBytes(910, 50);
        const base51 = Uint8Array.from([...prefix51, 0x11, ...pseudoRandomBytes(911, 9)]);
        const target51 = Uint8Array.from([...prefix51, 0x22]);
        const prefix52 = pseudoRandomBytes(920, 51);
        const base52 = Uint8Array.from([...prefix52, 0x11, ...pseudoRandomBytes(921, 9)]);
        const target52 = Uint8Array.from([...prefix52, 0x22]);
        const idBase51 = await writeBlob(ctx, base51);
        const idTarget51 = await writeBlob(ctx, target51);
        const idBase52 = await writeBlob(ctx, base52);
        const idTarget52 = await writeBlob(ctx, target52);
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idBase52, idBase51, idTarget52, idTarget51].map((id) => ({ id })),
          DEFAULT_POLICY,
        );

        // Assert
        expect(findEntry(result, idTarget51).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(result, idTarget52).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given a 64-byte sha256 target whose no-incumbent budget lands at exactly zero', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the candidate is refused before encodeDeltaFromIndex ever runs', async () => {
        // Arrange — floor(64 / 2) - 32 (sha256's digest length) is exactly 0:
        // the `=== 0` guard's own killer, distinct from the `< 0` underflow
        // that instead reports unbounded. base/target share every byte but
        // the last, so a 6-byte delta would exist if anything ever asked
        // encodeDeltaFromIndex to look — the refusal must land before that.
        const ctx = await buildSeededContext({ algorithm: 'sha256' });
        const base = pseudoRandomBytes(950, 64);
        const target = Uint8Array.from(base);
        target[63] = (target[63]! + 1) & 0xff;
        const idBase = await writeBlob(ctx, base);
        const idTarget = await writeBlob(ctx, target);
        const spy = vi.spyOn(deltaEncodeModule, 'encodeDeltaFromIndex');
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idBase, idTarget].map((id) => ({ id })),
          DEFAULT_POLICY,
        );

        // Assert
        expect(findEntry(result, idTarget).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });
    });
  });

  describe('Given a maxDepth of 0 and a sha256 target whose size sits in the unsigned-underflow band', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the depth guard refuses the only candidate even though the bound alone would be unbounded — it is not subsumed by it', async () => {
        // Arrange — 60 bytes sits in sha256's underflow band, where
        // floor(size / 2) - 32 is negative: were the depth guard absent,
        // searchBound would report unbounded (no cap at all), not zero, so
        // this is the case that actually distinguishes "the guard fires"
        // from "the bound coincidentally refuses". idBase and idTarget share
        // a 20-byte run, so a real match exists — encodeDeltaFromIndex would
        // succeed if it ever ran.
        const ctx = await buildSeededContext({ algorithm: 'sha256' });
        const shared = pseudoRandomBytes(960, 20);
        const idBase = await writeBlob(
          ctx,
          Uint8Array.from([...shared, ...pseudoRandomBytes(961, 50)]),
        );
        const idTarget = await writeBlob(
          ctx,
          Uint8Array.from([...shared, ...pseudoRandomBytes(962, 40)]),
        );
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 0,
          windowMemoryBudget: 0,
        };
        const spy = vi.spyOn(deltaEncodeModule, 'encodeDeltaFromIndex');
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idBase, idTarget].map((id) => ({ id })),
          policy,
        );

        // Assert
        expect(findEntry(result, idTarget).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });
    });
  });

  describe('Given an incumbent set by a chainDepth-1 candidate, and a strictly shallower chainDepth-0 candidate whose own delta is larger', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the shallower candidate still wins — a shallower base may beat the incumbent with a larger delta', async () => {
        // Arrange — target opens with a large shared run (runC) so its own
        // no-incumbent search budget is generous, decoupling "room to admit
        // the first candidate" from "how large that candidate's own delta
        // is" — memberX's and memberY's own sizes carry unrelated padding
        // that does not affect the delta actually found. memberY is
        // processed first (largest, empty window: a plain chainDepth-0
        // base). memberX, processed second, shares runC with memberY, so it
        // deltas off memberY too (chainDepth 1) before target is even
        // reached — a real, structural depth difference, not a synthetic
        // one. At target's turn, memberX (more recent, chainDepth 1) is
        // tried first and sets the incumbent; memberY (chainDepth 0,
        // strictly shallower) is tried second and, even though its own
        // delta against target is larger, the incumbent-aware bound scales
        // up enough at depth 0 to admit it anyway — sizes were measured,
        // not guessed, to make this land.
        const ctx = await buildSeededContext();
        const runC = pseudoRandomBytes(10, 2000);
        const runA = pseudoRandomBytes(11, 90);
        const runB = pseudoRandomBytes(12, 60);
        const target = Uint8Array.from([...runC, ...runA, ...runB]); // 2150 bytes
        const memberX = Uint8Array.from([...runC, ...runA, ...pseudoRandomBytes(13, 200)]); // 2290 bytes
        const memberY = Uint8Array.from([...runC, ...runB, ...pseudoRandomBytes(14, 233)]); // 2293 bytes, largest
        const idMemberY = await writeBlob(ctx, memberY);
        const idMemberX = await writeBlob(ctx, memberX);
        const idTarget = await writeBlob(ctx, target);
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 2,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idMemberY, idMemberX, idTarget].map((id) => ({ id })),
          policy,
        );

        // Assert — memberX really did delta off memberY first (sanity, not
        // the headline), and the target based directly off memberY, not
        // memberX.
        const memberXIndex = result.findIndex((r) => r.id === idMemberX);
        expect(chainDepthOf(result, memberXIndex)).toBe(1);
        const targetIndex = result.findIndex((r) => r.id === idTarget);
        expect((result[targetIndex]!.entry as { baseIndex: number }).baseIndex).toBe(
          result.findIndex((r) => r.id === idMemberY),
        );
      });
    });
  });

  describe('Given two chainDepth-1 candidates, both chained off a common ancestor, producing byte-identical raw deltas against the same target', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the same-size rule keeps the more-recently-admitted candidate — equal depth never displaces a tie', async () => {
        // Arrange — memberZ, memberOlder and memberNewer all open with a
        // large shared run (P) so every no-incumbent search along the way
        // has a generous budget (see the shallower-wins case above for why
        // this decoupling matters). memberOlder matches P immediately
        // followed by runA, so the two merge into one COPY against
        // whichever base offers P; memberNewer matches P then (after
        // unmatched runA) a separate, later runB — runB is 4 bytes longer
        // than runA to pay for that extra COPY instruction, so raw deltas
        // against a P-only base tie exactly, and both memberOlder and
        // memberNewer end up chaining off memberZ rather than off each
        // other: whichever is tried first (memberOlder, tried right after
        // it is admitted) sets the incumbent, and memberZ then displaces it
        // on the same tie-goes-to-the-shallower rule this test is about —
        // giving both memberOlder and memberNewer chainDepth 1, genuinely
        // equal, not asserted. Their own deltas against target then tie at
        // 72 bytes (measured). Sizes are strictly decreasing
        // (memberZ > memberOlder > memberNewer > target) so DESC-size
        // emission order is deterministic and target is processed last.
        // memberNewer, admitted after memberOlder (more recent), is tried
        // first by `selectBestCandidate` and sets the incumbent — the `>=`
        // mutant's killer is memberOlder then failing to displace it
        // despite an equal-length delta at equal depth.
        const ctx = await buildSeededContext();
        const runP = pseudoRandomBytes(70, 2000);
        const runA = pseudoRandomBytes(71, 60);
        const runB = pseudoRandomBytes(72, 64);
        const target = Uint8Array.from([...runP, ...runA, ...runB]); // 2124 bytes
        const memberZ = Uint8Array.from([...runP, ...pseudoRandomBytes(73, 300)]); // 2300 bytes
        const memberOlder = Uint8Array.from([...runP, ...runA, ...pseudoRandomBytes(74, 140)]); // 2200 bytes
        const memberNewer = Uint8Array.from([...runP, ...runB, ...pseudoRandomBytes(75, 86)]); // 2150 bytes
        const idMemberZ = await writeBlob(ctx, memberZ);
        const idMemberOlder = await writeBlob(ctx, memberOlder);
        const idMemberNewer = await writeBlob(ctx, memberNewer);
        const idTarget = await writeBlob(ctx, target);
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idMemberZ, idMemberOlder, idMemberNewer, idTarget].map((id) => ({ id })),
          DEFAULT_POLICY,
        );

        // Assert — both members really did land at chainDepth 1 (sanity,
        // not the headline), and the target based on memberNewer, not
        // memberOlder.
        const olderIndex = result.findIndex((r) => r.id === idMemberOlder);
        const newerIndex = result.findIndex((r) => r.id === idMemberNewer);
        expect(chainDepthOf(result, olderIndex)).toBe(1);
        expect(chainDepthOf(result, newerIndex)).toBe(1);
        const targetIndex = result.findIndex((r) => r.id === idTarget);
        expect((result[targetIndex]!.entry as { baseIndex: number }).baseIndex).toBe(newerIndex);
      });
    });
  });

  describe('Given a base/target pair whose 45-byte raw delta exceeds sha1’s bound but fits sha256’s unbounded search', () => {
    describe('When deltifyEntries runs under each hash algorithm', () => {
      it('Then hashSize tracks ctx.hash.digestLength — sha1 refuses the candidate and sha256 accepts it', async () => {
        // Arrange — a 20-byte shared run plus disjoint 40-byte tails gives a
        // 45-byte raw delta (measured): floor(60/2) - 20 = 10 (sha1, refuses
        // 45) versus floor(60/2) - 32 < 0 (sha256, unbounded). base carries 9
        // extra padding bytes past its own match so it is strictly larger
        // than target, making DESC-size emission order deterministic —
        // without it, base and target tie in size and content-addressed id
        // ordering could pick either one as the window's first member.
        const shared = pseudoRandomBytes(41, 20);
        const base = Uint8Array.from([
          ...shared,
          ...pseudoRandomBytes(42, 40),
          ...pseudoRandomBytes(919, 9),
        ]);
        const target = Uint8Array.from([...shared, ...pseudoRandomBytes(43, 40)]);
        const sut = deltifyEntries;

        // Act
        const sha1Ctx = await buildSeededContext({ algorithm: 'sha1' });
        const idBaseSha1 = await writeBlob(sha1Ctx, base);
        const idTargetSha1 = await writeBlob(sha1Ctx, target);
        const sha1Result = await sut(
          sha1Ctx,
          [idBaseSha1, idTargetSha1].map((id) => ({ id })),
          DEFAULT_POLICY,
        );
        const sha256Ctx = await buildSeededContext({ algorithm: 'sha256' });
        const idBaseSha256 = await writeBlob(sha256Ctx, base);
        const idTargetSha256 = await writeBlob(sha256Ctx, target);
        const sha256Result = await sut(
          sha256Ctx,
          [idBaseSha256, idTargetSha256].map((id) => ({ id })),
          DEFAULT_POLICY,
        );

        // Assert
        expect(findEntry(sha1Result, idTargetSha1).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(sha256Result, idTargetSha256).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });
});

describe('searchBound', () => {
  describe('Given no incumbent and sha1’s digest length, at target sizes straddling twice the bound floor', () => {
    describe('When searchBound computes the byte budget', () => {
      it('Then the budget is floor(targetSize / 2) minus the digest length, unscaled at depth 0', () => {
        // Arrange
        const sut = searchBound;

        // Act
        const at50 = sut(50, 20, undefined, 0, 50);
        const at51 = sut(51, 20, undefined, 0, 50);
        const at52 = sut(52, 20, undefined, 0, 50);

        // Assert
        expect(at50).toBe(5);
        expect(at51).toBe(5);
        expect(at52).toBe(6);
      });
    });
  });

  describe('Given no incumbent and sha256’s digest length, spanning the unsigned-underflow boundary', () => {
    describe('When searchBound computes the byte budget', () => {
      it('Then sizes below 64 bytes wrap to unbounded, 64 refuses at exactly zero, and larger sizes scale normally', () => {
        // Arrange
        const sut = searchBound;

        // Act
        const at50 = sut(50, 32, undefined, 0, 50);
        const at63 = sut(63, 32, undefined, 0, 50);
        const at64 = sut(64, 32, undefined, 0, 50);
        const at66 = sut(66, 32, undefined, 0, 50);
        const at76 = sut(76, 32, undefined, 0, 50);

        // Assert
        expect(at50).toBeUndefined();
        expect(at63).toBeUndefined();
        expect(at64).toBe(0);
        expect(at66).toBe(1);
        expect(at76).toBe(6);
      });
    });
  });

  describe('Given no incumbent and a target sized so the unscaled budget is 2 028 bytes', () => {
    describe('When searchBound computes the byte budget at increasing candidate depth', () => {
      it('Then the budget shrinks toward zero as candidate depth approaches the cap', () => {
        // Arrange
        const sut = searchBound;

        // Act
        const atDepth0 = sut(4096, 20, undefined, 0, 50);
        const atDepth25 = sut(4096, 20, undefined, 25, 50);
        const atDepth49 = sut(4096, 20, undefined, 49, 50);

        // Assert
        expect(atDepth0).toBe(2028);
        expect(atDepth25).toBe(1014);
        expect(atDepth49).toBe(40);
      });
    });
  });

  describe('Given an incumbent delta of 100 bytes at chain depth 3', () => {
    describe('When searchBound computes the byte budget for candidates at other depths', () => {
      it("Then a candidate at the incumbent's own depth keeps the full budget, a deeper one is squeezed, and a shallower one is given more room", () => {
        // Arrange
        const sut = searchBound;
        const incumbent = { delta: new Uint8Array(100), chainDepth: 3, emissionIndex: 0 };

        // Act — targetSize/hashSize are unused once an incumbent is present
        const sameDepth = sut(0, 0, incumbent, 3, 50);
        const deeper = sut(0, 0, incumbent, 10, 50);
        const shallower = sut(0, 0, incumbent, 1, 50);

        // Assert
        expect(sameDepth).toBe(100);
        expect(deeper).toBe(85);
        expect(shallower).toBe(104);
      });
    });
  });
});
