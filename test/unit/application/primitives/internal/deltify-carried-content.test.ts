/**
 * Coverage for `deltify.ts`'s carried-loose-content residency bound: the two
 * ways an `EmissionEntry` falls back to the emission loop's ordinary second
 * `readRawObject` read instead of reusing content the metadata pass already
 * carried forward — a packed source (metadata never had content to carry)
 * and a residency bound too small to carry anything. Both are correctness
 * fallbacks, not error paths: results stay identical either way.
 */
import { describe, expect, it, type MockInstance, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { deltifyEntries } from '../../../../../src/application/primitives/internal/deltify.js';
import * as readObjectModule from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { Blob, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { DeltaPolicy } from '../../../../../src/domain/storage/delta-policy.js';
import { PACK_ENTRY_TYPE } from '../../../../../src/domain/storage/pack-entry.js';
import { buildSeededContext } from '../fixtures.js';
import { writeSyntheticPack } from '../pack-fixture.js';

/** A pure function of (seed, index) — mirrors the sibling deltify/build-pack
 *  fixtures' own generator so two calls with the same seed always agree on
 *  their common prefix. */
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

type ReadRawObjectSpy = MockInstance<typeof readObjectModule.readRawObject>;

/** Counts this test's own reads of one object: the loose route's metadata
 *  pass (`readObjectMetadataWithContent`) always reads once regardless of
 *  carrying, so a carried object's count is that one baseline call — an
 *  excluded object's count is baseline PLUS the emission loop's fallback
 *  `readRawObject` call. The *difference* between two objects processed by
 *  the same run is what proves carrying happened, without depending on the
 *  baseline's absolute value. */
function readCallCountFor(spy: ReadRawObjectSpy, id: ObjectId): number {
  return spy.mock.calls.filter(([, calledId]) => calledId === id).length;
}

describe('deltifyEntries — carried-content residency bound', () => {
  describe('Given a zero-byte deltaCache budget and two deltifiable loose blobs', () => {
    describe('When deltifyEntries runs', () => {
      it('Then results are unaffected — nothing is carried, so every object falls back to the ordinary second read', async () => {
        // Arrange
        const ctx = createMemoryContext({ deltaCacheMaxBytes: 0 });
        const shared = pseudoRandomBytes(201, 300);
        const idA = await writeBlob(ctx, shared);
        const idB = await writeBlob(ctx, shared.slice(0, 200));
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [idA, idB], DEFAULT_POLICY);

        // Assert
        expect(result).toHaveLength(2);
        const deltas = result.filter((r) => r.entry.type === PACK_ENTRY_TYPE.OFS_DELTA);
        expect(deltas).toHaveLength(1);
      });
    });
  });

  describe('Given a packed base-entry blob and a loose blob sharing its content prefix', () => {
    describe('When deltifyEntries runs', () => {
      it('Then the loose blob still deltas against the packed one via the ordinary second read', async () => {
        // Arrange — the packed route never carries content (metadata alone
        // gives the size for free), so the packed object must fall back to a
        // second read in the emission loop exactly like before this change.
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(202, 300);
        const [packedId] = await writeSyntheticPack(ctx, 'carried-content', [
          { kind: 'base', type: 'blob', content: shared },
        ]);
        const looseId = await writeBlob(ctx, Uint8Array.from([...shared, 0x01]));
        const sut = deltifyEntries;

        // Act
        const result = await sut(ctx, [packedId as ObjectId, looseId], DEFAULT_POLICY);

        // Assert
        expect(result).toHaveLength(2);
        const deltas = result.filter((r) => r.entry.type === PACK_ENTRY_TYPE.OFS_DELTA);
        expect(deltas).toHaveLength(1);
      });
    });
  });

  describe('Given a budget that fits the first loose object alone but not the first plus the second', () => {
    describe('When deltifyEntries runs', () => {
      it('Then only the second object falls back to a second read — the first stays carried and carriedBytes accumulates from it', async () => {
        // Arrange — budget(100) admits idFits(60) alone; idFits's own bytes
        // must then accumulate into carriedBytes so idExceeds(50) is
        // correctly seen as 60+50=110 > 100 and excluded.
        const ctx = createMemoryContext({ deltaCacheMaxBytes: 100 });
        const idFits = await writeBlob(ctx, pseudoRandomBytes(301, 60));
        const idExceeds = await writeBlob(ctx, pseudoRandomBytes(302, 50));
        const spy = vi.spyOn(readObjectModule, 'readRawObject');
        const sut = deltifyEntries;

        // Act
        await sut(ctx, [idFits, idExceeds], DEFAULT_POLICY);

        // Assert — idExceeds pays for one extra read (the emission loop's
        // fallback) that idFits, carried forward, never needs.
        const fitsCalls = readCallCountFor(spy, idFits);
        const exceedsCalls = readCallCountFor(spy, idExceeds);
        expect(exceedsCalls).toBe(fitsCalls + 1);
        spy.mockRestore();
      });
    });
  });

  describe("Given a budget exactly equal to the first loose object's content length", () => {
    describe('When deltifyEntries runs', () => {
      it('Then the boundary object is still carried — the bound admits equal, not just strictly-under', async () => {
        // Arrange — idBoundary's own weight (60) exactly equals the budget
        // (60): the real check (`>`) does not exclude on equality, so
        // idBoundary is carried and idNext(10) then sees carriedBytes
        // already at 60, correctly excluding it (60+10=70 > 60).
        const ctx = createMemoryContext({ deltaCacheMaxBytes: 60 });
        const idBoundary = await writeBlob(ctx, pseudoRandomBytes(303, 60));
        const idNext = await writeBlob(ctx, pseudoRandomBytes(304, 10));
        const spy = vi.spyOn(readObjectModule, 'readRawObject');
        const sut = deltifyEntries;

        // Act
        await sut(ctx, [idBoundary, idNext], DEFAULT_POLICY);

        // Assert — idBoundary (carried) reads once fewer than idNext
        // (excluded, and only excluded because idBoundary's carry already
        // consumed the whole budget).
        const boundaryCalls = readCallCountFor(spy, idBoundary);
        const nextCalls = readCallCountFor(spy, idNext);
        expect(boundaryCalls).toBe(nextCalls - 1);
        spy.mockRestore();
      });
    });
  });
});
