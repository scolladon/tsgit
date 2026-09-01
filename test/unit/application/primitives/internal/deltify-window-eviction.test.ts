/**
 * Coverage for the sliding window's eviction accounting: the count bound
 * (`policy.window`), the memory bound (`policy.windowMemoryBudget`), and
 * `memberWeight`'s own charge (content bytes PLUS the built `DeltaIndex`).
 * Each test proves a boundary or an ordering property that only shows up
 * through a LATER object's search — eviction itself has no return value,
 * so "was the right member kept or dropped" is only observable via whether
 * a subsequent probe still finds it as a delta base.
 */
import { describe, expect, it } from 'vitest';
import { deltifyEntries } from '../../../../../src/application/primitives/internal/deltify.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { Blob, ObjectId } from '../../../../../src/domain/objects/index.js';
import * as deltaEncodeModule from '../../../../../src/domain/storage/delta-encode.js';
import type { DeltaPolicy } from '../../../../../src/domain/storage/delta-policy.js';
import { PACK_ENTRY_TYPE } from '../../../../../src/domain/storage/pack-entry.js';
import { buildSeededContext } from '../fixtures.js';

/** A pure function of (seed, index) — mirrors the sibling deltify fixtures'
 *  own generator so two calls with the same seed always agree on their
 *  common prefix. */
function pseudoRandomByte(seed: number, index: number): number {
  const h = Math.imul(seed ^ index, 0x9e3779b1) ^ (index << 13);
  return (Math.imul(h, 0x85ebca6b) >>> 24) & 0xff;
}

function pseudoRandomBytes(seed: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_unused, i) => pseudoRandomByte(seed, i));
}

async function writeBlob(ctx: Awaited<ReturnType<typeof buildSeededContext>>, content: Uint8Array) {
  const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
  return writeObject(ctx, blob);
}

/** A window member's true resident cost, computed the same way
 *  `memberWeight` does — lets a test set `windowMemoryBudget` to an exact
 *  boundary rather than a guessed round number. */
function chargedWeight(content: Uint8Array): number {
  const index = deltaEncodeModule.createDeltaIndex(content);
  return content.length + index.heads.byteLength + index.next.byteLength;
}

function findEntry(
  results: Awaited<ReturnType<typeof deltifyEntries>>,
  id: ObjectId,
): (typeof results)[number] {
  const found = results.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no result for ${id}`);
  return found;
}

describe('deltifyEntries — window eviction accounting', () => {
  describe('Given windowMemoryBudget disabled (0) and an older member still resident when a newer, unrelated one is admitted', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the older member is never evicted for budget reasons — a disabled budget evicts nothing', async () => {
        // Arrange — obj1(400B) is admitted first; obj2(350B, unrelated) is
        // admitted second. With the budget disabled, only the count bound
        // (window: 10, never reached with 2 members) can evict — so obj1
        // must still be resident when probe searches.
        const ctx = await buildSeededContext();
        const sharedContent = pseudoRandomBytes(801, 400);
        const unrelatedContent = pseudoRandomBytes(802, 350);
        const idObj1 = await writeBlob(ctx, sharedContent);
        const idObj2 = await writeBlob(ctx, unrelatedContent);
        const idProbe = await writeBlob(ctx, sharedContent.slice(0, 300));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idObj1, idObj2, idProbe], policy);

        // Assert
        expect(findEntry(result, idProbe).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given a windowMemoryBudget exactly equal to the sum of two members already charged for content plus DeltaIndex', () => {
    describe('When deltifyEntries runs', () => {
      it('Then admitting the second member does not evict the first — the bound is inclusive, not exclusive', async () => {
        // Arrange — budget = chargedWeight(obj1) + chargedWeight(obj2)
        // exactly. Real accounting (`>`) only evicts once resident+incoming
        // is STRICTLY over budget; at exact equality it must not.
        const ctx = await buildSeededContext();
        const sharedContent = pseudoRandomBytes(803, 400);
        const unrelatedContent = pseudoRandomBytes(804, 350);
        const idObj1 = await writeBlob(ctx, sharedContent);
        const idObj2 = await writeBlob(ctx, unrelatedContent);
        const idProbe = await writeBlob(ctx, sharedContent.slice(0, 300));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: chargedWeight(sharedContent) + chargedWeight(unrelatedContent),
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idObj1, idObj2, idProbe], policy);

        // Assert
        expect(findEntry(result, idProbe).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given a resident member alone already at the budget and a second, unrelated member being admitted', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the resident is evicted — memory pressure is charged as resident PLUS incoming, not resident MINUS incoming', async () => {
        // Arrange — budget = chargedWeight(obj1) exactly, so obj1 alone
        // fits. obj2's admission adds incoming bytes on top: resident+incoming
        // now exceeds budget, so obj1 must be evicted even though obj2's
        // own weight alone never would have breached it.
        const ctx = await buildSeededContext();
        const sharedContent = pseudoRandomBytes(805, 400);
        const unrelatedContent = pseudoRandomBytes(806, 350);
        const idObj1 = await writeBlob(ctx, sharedContent);
        const idObj2 = await writeBlob(ctx, unrelatedContent);
        const idProbe = await writeBlob(ctx, sharedContent.slice(0, 300));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: chargedWeight(sharedContent),
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idObj1, idObj2, idProbe], policy);

        // Assert — obj1 gone, and obj2 shares nothing with probe, so no
        // candidate survives for probe to match.
        expect(findEntry(result, idProbe).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe("Given a budget one byte below an object's true weight — content length plus its built DeltaIndex", () => {
    describe('When deltifyEntries runs', () => {
      it('Then the object is refused — undercharging the index by dropping `next` would wrongly admit it', async () => {
        // Arrange — realWeight = content.length + heads + next. A budget of
        // realWeight - 1 refuses admission by the narrowest possible
        // margin: undercounting `next` (e.g. subtracting instead of adding
        // it) shrinks the computed weight enough to wrongly fit.
        const ctx = await buildSeededContext();
        const sharedPrefix = pseudoRandomBytes(807, 200);
        const bigTail = pseudoRandomBytes(808, 72);
        const bigContent = Uint8Array.from([...sharedPrefix, ...bigTail]);
        const idBig = await writeBlob(ctx, bigContent);
        const idSmall = await writeBlob(ctx, Uint8Array.from([...sharedPrefix, 0x42]));
        const realWeight = chargedWeight(bigContent);
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: realWeight - 1,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idBig, idSmall], policy);

        // Assert
        expect(findEntry(result, idBig).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(findEntry(result, idSmall).entry.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe("Given a budget exactly equal to an object's true weight", () => {
    describe('When deltifyEntries runs', () => {
      it('Then the object is admitted — the single-object over-budget refusal is exclusive, not inclusive', async () => {
        // Arrange — the mirror image of the "one byte below" case: at exact
        // equality the object must fit.
        const ctx = await buildSeededContext();
        const sharedPrefix = pseudoRandomBytes(809, 200);
        const bigTail = pseudoRandomBytes(810, 72);
        const bigContent = Uint8Array.from([...sharedPrefix, ...bigTail]);
        const idBig = await writeBlob(ctx, bigContent);
        const idSmall = await writeBlob(ctx, Uint8Array.from([...sharedPrefix, 0x42]));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 10,
          maxDepth: 50,
          windowMemoryBudget: chargedWeight(bigContent),
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idBig, idSmall], policy);

        // Assert
        expect(findEntry(result, idSmall).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given policy.window = 0 and a single object', () => {
    describe('When deltifyEntries runs', () => {
      it('Then admission never evicts from an already-empty window', async () => {
        // Arrange — the very first admission always starts from an empty
        // window; a count-eviction guard that ignored emptiness would try
        // to evict a member that was never there.
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, pseudoRandomBytes(811, 40));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 0,
          maxDepth: 50,
          windowMemoryBudget: 0,
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [id], policy);

        // Assert
        expect(result).toHaveLength(1);
      });
    });
  });

  describe('Given a window capped at 2 members and a third admission that evicts exactly one for count', () => {
    describe('When deltifyEntries runs', () => {
      it("Then the count-evicted member's weight is subtracted from residentBytes, not added — a later member's budget check must not inherit a doubled charge", async () => {
        // Arrange — objA(largest) and objB fit under budget (=
        // chargedWeight(objA) + chargedWeight(objB) exactly) together, so
        // no eviction happens admitting either. objC's admission is where
        // window: 2 forces a count-eviction of objA. If that eviction
        // wrongly ADDED objA's weight to residentBytes instead of
        // subtracting it, the very next budget check (still in the same
        // admission) would see an inflated total and wrongly evict objB
        // too — objB is the one probe needs to still find.
        const ctx = await buildSeededContext();
        const contentA = pseudoRandomBytes(812, 90);
        const contentB = pseudoRandomBytes(813, 70);
        const contentC = pseudoRandomBytes(814, 50);
        const idObjA = await writeBlob(ctx, contentA);
        const idObjB = await writeBlob(ctx, contentB);
        const idObjC = await writeBlob(ctx, contentC);
        const idProbe = await writeBlob(ctx, contentB.slice(0, 32));
        const policy: DeltaPolicy = {
          enabled: true,
          window: 2,
          maxDepth: 50,
          windowMemoryBudget: chargedWeight(contentA) + chargedWeight(contentB),
        };
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idObjA, idObjB, idObjC, idProbe], policy);

        // Assert — objB must still be resident for probe to delta against it.
        expect(findEntry(result, idProbe).entry.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });
});
