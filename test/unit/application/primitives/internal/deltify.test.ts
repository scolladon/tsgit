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
        // Arrange — a sliding 30-byte window over one backbone: obj[k] and
        // obj[k-1] overlap in all but a ~30-byte edge (tiny insert, cheap
        // delta), while obj[k] and obj[k-2] overlap in all but ~60 bytes —
        // strictly worse, never a tie — so the search always strictly
        // prefers the immediate predecessor and a straight chain grows.
        // window=1 cannot build this: after a promoted base and the object
        // that just used it both compete for the window's one slot, the
        // base — being shallower — always keeps it, so every window=1
        // chain caps at depth 1 regardless of content; window=2 leaves room
        // for both, so the chain can keep deepening until the cap excludes
        // the deepest member, at which point the chain resets and grows
        // again (sawtooth).
        const ctx = await buildSeededContext();
        const backbone = pseudoRandomBytes(3, 5000);
        const slide = 30;
        const windowLength = 3000;
        const ids: ObjectId[] = [];
        for (let k = 0; k < 8; k += 1) {
          const length = windowLength - k * 5;
          ids.push(await writeBlob(ctx, backbone.slice(k * slide, k * slide + length)));
        }
        const policy: DeltaPolicy = {
          enabled: true,
          window: 2,
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
        // Arrange — obj1(110B) and obj2(100B) together fit the budget,
        // charging each one's content length PLUS its DeltaIndex (heads +
        // next) — the same total admitToWindow now applies. Admitting
        // obj3(90B) forces eviction, and obj1 (oldest) goes first. probe1
        // and probe2 are both above the 50-byte floor (unlike obj3, which
        // stays above it too) and both strictly smaller than obj3, so they
        // are the last two processed: probe1 shares obj1's pattern and must
        // fail to find a candidate (its base was evicted); probe2 shares
        // obj2's pattern and must succeed (its base survives).
        const ctx = await buildSeededContext();
        const r1 = pseudoRandomBytes(101, 110);
        const r2 = pseudoRandomBytes(202, 100);
        const r3 = pseudoRandomBytes(303, 90);
        const id1 = await writeBlob(ctx, r1);
        const id2 = await writeBlob(ctx, r2);
        const id3 = await writeBlob(ctx, r3);
        const idProbe2 = await writeBlob(ctx, r2.slice(0, 60));
        const idProbe1 = await writeBlob(ctx, r1.slice(0, 50));
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
        // The entry name is long enough to carry the serialised tree past the
        // fifty-byte delta floor (`100644 ` + name + NUL + a 20-byte digest =
        // 54 bytes here). A shorter name puts both objects under the floor,
        // which skips the window before the type is ever compared — the test
        // would still pass, having exercised nothing.
        const ctx = await buildSeededContext();
        const leafBlobId = await writeBlob(ctx, new Uint8Array([9]));
        const treeId = await writeTree(ctx, [
          treeEntry('100644' as FileMode, 'a-long-enough-filename.bin', leafBlobId),
        ]);
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

  describe('Given a chainDepth-1 incumbent tried BEFORE a strictly shallower chainDepth-0 candidate, tying it exactly in raw delta length', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the shallower candidate displaces the incumbent despite being tried second', async () => {
        // Arrange — nameHash forces D, mid, deep, target processing in that
        // exact order (sidestepping size-based emission-order interaction).
        // `mid` deltas off `d` (chainDepth 1), promoting `d` to the window's
        // most-recently-used slot. `deep` then deltas off `mid` (chainDepth
        // 2), promoting `mid` in turn — so at target's turn the window tries
        // `mid` (chainDepth 1) FIRST, setting the incumbent, `deep`
        // (chainDepth 2, bound-squeezed, no match) SECOND, and `d`
        // (chainDepth 0, strictly shallower) LAST. `d` and `mid` both open
        // with the byte-identical `sharedRun` at offset 0, so their raw
        // deltas against `target` are the same COPY(0,1800)+INSERT(target's
        // own tail) shape — an exact length tie — with `d` strictly
        // shallower. Per the same-size rule, `d` must displace `mid`.
        const ctx = await buildSeededContext();
        const sharedRun = pseudoRandomBytes(910, 1800);
        const runM = pseudoRandomBytes(911, 600);
        const tailD = pseudoRandomBytes(912, 100);
        const tailMid = pseudoRandomBytes(913, 40);
        const tailDeep = pseudoRandomBytes(914, 40);
        const tailTarget = pseudoRandomBytes(915, 50);
        const dContent = Uint8Array.from([...sharedRun, ...tailD]);
        const midContent = Uint8Array.from([...sharedRun, ...runM, ...tailMid]);
        const deepContent = Uint8Array.from([...runM, ...tailDeep]);
        const targetContent = Uint8Array.from([...sharedRun, ...tailTarget]);
        const idD = await writeBlob(ctx, dContent);
        const idMid = await writeBlob(ctx, midContent);
        const idDeep = await writeBlob(ctx, deepContent);
        const idTarget = await writeBlob(ctx, targetContent);
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [
            { id: idD, nameHash: 4 },
            { id: idMid, nameHash: 3 },
            { id: idDeep, nameHash: 2 },
            { id: idTarget, nameHash: 1 },
          ],
          DEFAULT_POLICY,
        );

        // Assert — sanity: mid and deep landed at the depths the arrangement
        // depends on, then the headline: target based on `d`, not `mid`.
        const midIndex = result.findIndex((r) => r.id === idMid);
        const deepIndex = result.findIndex((r) => r.id === idDeep);
        expect(chainDepthOf(result, midIndex)).toBe(1);
        expect(chainDepthOf(result, deepIndex)).toBe(2);
        const targetIndex = result.findIndex((r) => r.id === idTarget);
        expect((result[targetIndex]!.entry as { baseIndex: number }).baseIndex).toBe(
          result.findIndex((r) => r.id === idD),
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

  describe('Given a window of three residents where a target picks the middle one, and a following target that ties equally against the promoted member and the untouched oldest one', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the following target bases off the just-promoted member, not the oldest resident', async () => {
        // Arrange — idA, idB and idC are admitted as unrelated bases (idA
        // largest, idB, idC newest); idTarget1 uniquely matches idB (shares
        // runP, nothing else does), so idB is promoted to most-recent.
        // idTarget2 shares runQ with both idB and idC at the same offset —
        // a byte-identical raw delta either way — so only scan order (most
        // recent tried first) decides: promoted, idB is tried before idC.
        const ctx = await buildSeededContext();
        const runQ = pseudoRandomBytes(910, 200);
        const runP = pseudoRandomBytes(911, 900);
        const uniqueA = pseudoRandomBytes(900, 3000);
        const uniqueB = pseudoRandomBytes(912, 1000);
        const uniqueC = pseudoRandomBytes(913, 1800);
        const tail1 = pseudoRandomBytes(914, 300);
        const tail2 = pseudoRandomBytes(915, 50);
        const idA = await writeBlob(ctx, uniqueA);
        const idB = await writeBlob(ctx, Uint8Array.from([...runQ, ...runP, ...uniqueB]));
        const idC = await writeBlob(ctx, Uint8Array.from([...runQ, ...uniqueC]));
        const idTarget1 = await writeBlob(ctx, Uint8Array.from([...runP, ...tail1]));
        const idTarget2 = await writeBlob(ctx, Uint8Array.from([...runQ, ...tail2]));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 4,
          maxDepth: 50,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idA, idB, idC, idTarget1, idTarget2].map((id) => ({ id })),
          policy,
        );

        // Assert
        const target2Entry = findEntry(result, idTarget2).entry;
        expect(target2Entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect((target2Entry as { baseIndex: number }).baseIndex).toBe(
          result.findIndex((r) => r.id === idB),
        );
      });
    });
  });

  describe('Given a promotion round whose emitted object and promoted base both compete for one eviction slot', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the emitted object — not the promoted base — is the one evicted first', async () => {
        // Arrange — idB is admitted alone, idN hits it (promoting idB,
        // window becomes […, idN, idB] with idB most recent). idProbe is
        // unrelated (no hit), and admitting it at window capacity 2 evicts
        // whichever of idN/idB is oldest. idFollow shares content with idB
        // only (not idN, not idProbe): it deltas cleanly only if idB
        // survived the eviction — proving idB, not idN, sits last.
        const ctx = await buildSeededContext();
        const runR = pseudoRandomBytes(2010, 1800);
        const runF = pseudoRandomBytes(2011, 900);
        const tailB = pseudoRandomBytes(2012, 300);
        const tailN = pseudoRandomBytes(2013, 100);
        const tailFollow = pseudoRandomBytes(2014, 50);
        const probeContent = pseudoRandomBytes(2015, 1200);
        const idB = await writeBlob(ctx, Uint8Array.from([...runR, ...runF, ...tailB]));
        const idN = await writeBlob(ctx, Uint8Array.from([...runR, ...tailN]));
        const idProbe = await writeBlob(ctx, probeContent);
        const idFollow = await writeBlob(ctx, Uint8Array.from([...runF, ...tailFollow]));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 2,
          maxDepth: 50,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idB, idN, idProbe, idFollow].map((id) => ({ id })),
          policy,
        );

        // Assert
        expect(findEntry(result, idFollow).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given a delta that lands exactly at policy.maxDepth', () => {
    describe('When deltifyEntries runs', () => {
      it('Then it is still emitted at the cap, but neither it nor its base changes the window for the next target', async () => {
        // Arrange — a sliding 100-byte window over one backbone builds a
        // straight chain: ids[0] <- ids[1] <- ids[2] <- ids[3], each
        // strictly preferring its immediate predecessor. ids[4] hits
        // ids[3] at chainDepth 3 (== maxDepth): still emitted as a valid
        // delta, but excluded from promotion. idProbeEvict (unrelated)
        // then admits at window capacity 2, evicting whichever of
        // ids[3]/ids[1] is oldest. idFollowUp matches a byte range present
        // in BOTH ids[1] and ids[3]; which one it bases off reveals which
        // one survived — ids[1] survives only if ids[3] was never promoted
        // (stayed oldest) and ids[4] never took a window slot.
        const ctx = await buildSeededContext();
        const backbone = pseudoRandomBytes(3020, 5000);
        const slide = 100;
        const windowLength = 3000;
        const lens: number[] = [];
        const ids: ObjectId[] = [];
        for (let k = 0; k < 5; k += 1) {
          const length = windowLength - k * 5;
          lens.push(length);
          ids.push(await writeBlob(ctx, backbone.slice(k * slide, k * slide + length)));
        }
        const probeEvictContent = pseudoRandomBytes(3021, windowLength - 30);
        const idProbeEvict = await writeBlob(ctx, probeEvictContent);
        const idx0End = lens[0]!;
        const idx1End = 1 * slide + lens[1]!;
        const followUpContent = Uint8Array.from([
          ...backbone.slice(idx0End, idx1End),
          ...pseudoRandomBytes(3022, 10),
        ]);
        const idFollowUp = await writeBlob(ctx, followUpContent);
        const policy: DeltaPolicy = {
          enabled: true,
          window: 2,
          maxDepth: 3,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [...ids, idProbeEvict, idFollowUp].map((id) => ({ id })),
          policy,
        );

        // Assert — the at-cap delta still emits correctly, at the cap
        const cappedIndex = result.findIndex((r) => r.id === ids[4]);
        expect(chainDepthOf(result, cappedIndex)).toBe(policy.maxDepth);
        expect(findEntry(result, ids[4]!).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        // Assert — the window is unaffected: ids[1] (not ids[3]) survives
        const followUpEntry = findEntry(result, idFollowUp).entry;
        expect(followUpEntry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect((followUpEntry as { baseIndex: number }).baseIndex).toBe(
          result.findIndex((r) => r.id === ids[1]),
        );
      });
    });
  });

  describe('Given a candidate that is found and would otherwise promote its base, but is rejected on deflated size', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the base is never promoted — it is evicted in its normal, untouched order', async () => {
        // Arrange — idBase and idLoser share the same 1800-byte repeat run
        // that produces a deflate-size tie (see the sibling fixture above):
        // idLoser's candidacy against idBase is found but rejected, so
        // idLoser is admitted as a plain base, never promoting idBase.
        // idProbeEvict (unrelated) then admits at window capacity 2,
        // evicting whichever of idBase/idLoser is oldest. idCheck matches
        // only idBase's own distinguishing tail: it deltas cleanly only if
        // a bug wrongly promoted idBase (kept it resident past its normal,
        // oldest-first turn).
        const ctx = await buildSeededContext();
        const sharedRun = new Uint8Array(1800).fill(0x41);
        const entropyTail = pseudoRandomBytes(42, 200);
        const baseTail = new Uint8Array(201).fill(0x42);
        const baseContent = Uint8Array.from([...sharedRun, ...baseTail]);
        const loserContent = Uint8Array.from([...sharedRun, ...entropyTail]);
        const probeEvictContent = pseudoRandomBytes(4001, 500);
        const checkContent = Uint8Array.from([...baseTail, ...pseudoRandomBytes(4002, 20)]);
        const idBase = await writeBlob(ctx, baseContent);
        const idLoser = await writeBlob(ctx, loserContent);
        const idProbeEvict = await writeBlob(ctx, probeEvictContent);
        const idCheck = await writeBlob(ctx, checkContent);
        const policy: DeltaPolicy = {
          enabled: true,
          window: 2,
          maxDepth: 5,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idBase, idLoser, idProbeEvict, idCheck].map((id) => ({ id })),
          policy,
        );

        // Assert
        expect(findEntry(result, idLoser).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(result, idCheck).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given a promotion round that removes a member, re-admits a pending one, then re-appends the removed member', () => {
    describe('When deltifyEntries runs', () => {
      it('Then residentBytes still equals the sum of memberWeight over the window — no operation drifts the count', async () => {
        // Arrange — idObj0 is admitted alone, idObj1 hits it and promotes
        // it (window becomes [idObj1, idObj0], residentBytes exactly the
        // sum of both members' weight). windowMemoryBudget is pinned to
        // that exact sum, so idObj2's admission (any nonzero weight) must
        // evict exactly the oldest member (idObj1) and no more — a drift
        // in `without`, `admitToWindow` or `readmit` either evicts too
        // little (idProbe1 would still find idObj1) or too much (idProbe0
        // would no longer find idObj0).
        const ctx = await buildSeededContext();
        const runR = pseudoRandomBytes(5010, 1800);
        const tail0 = pseudoRandomBytes(5011, 300);
        const tail1 = pseudoRandomBytes(5012, 100);
        const obj0Content = Uint8Array.from([...runR, ...tail0]);
        const obj1Content = Uint8Array.from([...runR, ...tail1]);
        const obj0Index = deltaEncodeModule.createDeltaIndex(obj0Content);
        const obj1Index = deltaEncodeModule.createDeltaIndex(obj1Content);
        const obj0Weight =
          obj0Content.length + obj0Index.heads.byteLength + obj0Index.next.byteLength;
        const obj1Weight =
          obj1Content.length + obj1Index.heads.byteLength + obj1Index.next.byteLength;
        const idObj0 = await writeBlob(ctx, obj0Content);
        const idObj1 = await writeBlob(ctx, obj1Content);
        const idObj2 = await writeBlob(ctx, pseudoRandomBytes(5013, 400));
        const idProbe1 = await writeBlob(
          ctx,
          Uint8Array.from([...tail1.slice(0, 250), ...pseudoRandomBytes(5014, 20)]),
        );
        const idProbe0 = await writeBlob(
          ctx,
          Uint8Array.from([...tail0.slice(0, 250), ...pseudoRandomBytes(5015, 20)]),
        );
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: obj0Weight + obj1Weight,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idObj0, idObj1, idObj2, idProbe1, idProbe0].map((id) => ({ id })),
          policy,
        );

        // Assert
        expect(findEntry(result, idProbe1).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        const probe0Entry = findEntry(result, idProbe0).entry;
        expect(probe0Entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect((probe0Entry as { baseIndex: number }).baseIndex).toBe(
          result.findIndex((r) => r.id === idObj0),
        );
      });
    });
  });

  describe('Given a promotion that readmits an already-indexed window member', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the DeltaIndex is reused, not rebuilt — createDeltaIndex is called once per object, never again on promotion', async () => {
        // Arrange — idObj0 is admitted alone (one createDeltaIndex call),
        // idObj1 hits it and promotes it back into the window (a second
        // call, for idObj1's own admission). A rebuild on promotion would
        // add a third call for idObj0.
        const ctx = await buildSeededContext();
        const runR = pseudoRandomBytes(6010, 1800);
        const tail0 = pseudoRandomBytes(6011, 300);
        const tail1 = pseudoRandomBytes(6012, 100);
        const idObj0 = await writeBlob(ctx, Uint8Array.from([...runR, ...tail0]));
        const idObj1 = await writeBlob(ctx, Uint8Array.from([...runR, ...tail1]));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: 0,
        };
        const spy = vi.spyOn(deltaEncodeModule, 'createDeltaIndex');
        const sut = deltifyEntries;

        // Act
        await sut(
          ctx,
          [idObj0, idObj1].map((id) => ({ id })),
          policy,
        );

        // Assert
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRestore();
      });
    });
  });

  describe('Given two near-identical 49-byte objects and two near-identical 50-byte objects, each target an exact prefix of its own base', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the 49-byte target stays a base — the floor excludes it even though the bound alone would admit it — and the 50-byte target deltas', async () => {
        // Arrange — targetN is an exact N-byte prefix of baseN (baseN
        // padded past targetN's own length so DESC-size emission order
        // admits the base first). A prefix match encodes as a single
        // COPY(offset 0, size N) with no INSERT — header(2) + copy(2) = 4
        // bytes for N < 256 — comfortably inside both no-incumbent bounds
        // (sha1: floor(49/2)-20=4, floor(50/2)-20=5), so only the floor —
        // never the bound — can be what excludes the 49-byte pair. This is
        // the `<` vs `<=` killer on the floor comparison: an off-by-one
        // (`<=`) would wrongly exclude the 50-byte pair too.
        const ctx = await buildSeededContext();
        const prefix49 = pseudoRandomBytes(930, 49);
        const base49 = Uint8Array.from([...prefix49, ...pseudoRandomBytes(931, 10)]);
        const prefix50 = pseudoRandomBytes(932, 50);
        const base50 = Uint8Array.from([...prefix50, ...pseudoRandomBytes(933, 10)]);
        const idBase49 = await writeBlob(ctx, base49);
        const idTarget49 = await writeBlob(ctx, prefix49);
        const idBase50 = await writeBlob(ctx, base50);
        const idTarget50 = await writeBlob(ctx, prefix50);
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [idBase49, idBase50, idTarget49, idTarget50].map((id) => ({ id })),
          DEFAULT_POLICY,
        );

        // Assert
        expect(findEntry(result, idTarget49).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(result, idTarget50).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given a 49-byte object placed first via a nameHash tiebreak, and a 4,096-byte target built by tiling its exact content', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the target never deltas against it — an under-floor object is never admitted as a base, even for a target the search bound would legally allow', async () => {
        // Arrange — nameHash sorts DESC ahead of size, so idUnder (49B,
        // nameHash 1) is emitted BEFORE idTarget (4096B, nameHash 0)
        // despite being far smaller — the only way to place a floor-
        // excluded object ahead of a target it could otherwise base
        // against. Were idUnder actually admitted, tiling its content
        // across idTarget would resolve to a handful of cheap COPY
        // instructions well inside the no-incumbent bound
        // (floor(4096/2)-20=2028) — a candidate the bound itself would
        // accept, not one it would refuse.
        const ctx = await buildSeededContext();
        const underContent = pseudoRandomBytes(940, 49);
        const targetContent = Uint8Array.from(
          { length: 4096 },
          (_unused, i) => underContent[i % underContent.length]!,
        );
        const idUnder = await writeBlob(ctx, underContent);
        const idTarget = await writeBlob(ctx, targetContent);
        const sut = deltifyEntries;

        // Act
        const result = await sut(
          ctx,
          [
            { id: idUnder, nameHash: 1 },
            { id: idTarget, nameHash: 0 },
          ],
          DEFAULT_POLICY,
        );

        // Assert
        expect(findEntry(result, idTarget).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given a 49-byte object placed first via a nameHash tiebreak, and a larger object that opens with its exact content', () => {
    describe('When deltifyEntries runs', () => {
      it('Then createDeltaIndex is never called for the under-floor object — its own admission is skipped, not merely its search', async () => {
        // Arrange — idFollow (300B) opens with idUnder's own 49 bytes, so a
        // delta would be available if idUnder had been admitted; instead,
        // with idUnder excluded from admission entirely, createDeltaIndex
        // is called exactly once — for idFollow's own, ordinary admission —
        // never a second time for idUnder. This is the guard's second,
        // independent effect: the prior case already proves the search is
        // skipped for an under-floor object as a TARGET; this proves
        // admission is skipped for it as a prospective BASE.
        const ctx = await buildSeededContext();
        const underContent = pseudoRandomBytes(941, 49);
        const followContent = Uint8Array.from([...underContent, ...pseudoRandomBytes(942, 251)]);
        const idUnder = await writeBlob(ctx, underContent);
        const idFollow = await writeBlob(ctx, followContent);
        const spy = vi.spyOn(deltaEncodeModule, 'createDeltaIndex');
        const sut = deltifyEntries;

        // Act
        await sut(
          ctx,
          [
            { id: idUnder, nameHash: 1 },
            { id: idFollow, nameHash: 0 },
          ],
          DEFAULT_POLICY,
        );

        // Assert
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
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
