import { describe, expect, it, vi } from 'vitest';
import {
  detectSimilarityRenames,
  hydrateFingerprints,
} from '../../../../../src/application/primitives/detect-similarity-renames.js';
import * as readBlobMod from '../../../../../src/application/primitives/read-blob.js';
import * as readObjectMod from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type {
  AddChange,
  DeleteChange,
  TreeDiff,
} from '../../../../../src/domain/diff/diff-change.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

type Ctx = Awaited<ReturnType<typeof buildSeededContext>>;

const writeBlob = (ctx: Ctx, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const addChange = (path: string, newId: ObjectId): AddChange => ({
  type: 'add',
  newPath: path as FilePath,
  newId,
  newMode: '100644',
});

const deleteChange = (path: string, oldId: ObjectId): DeleteChange => ({
  type: 'delete',
  oldPath: path as FilePath,
  oldId,
  oldMode: FILE_MODE.REGULAR,
});

/** Distinct (never identical-content) delete/add halves, so every pair
 *  reaches the INEXACT pass instead of being consumed by the exact-match
 *  pass ahead of it. */
async function buildDistinctPairDiff(
  ctx: Ctx,
  deleteCount: number,
  addCount: number,
): Promise<{ readonly diff: TreeDiff; readonly uniqueIdCount: number }> {
  const deletes: DeleteChange[] = [];
  for (let i = 0; i < deleteCount; i += 1) {
    deletes.push(deleteChange(`d${i}.txt`, await writeBlob(ctx, `delete-side-${i}`)));
  }
  const adds: AddChange[] = [];
  for (let i = 0; i < addCount; i += 1) {
    adds.push(addChange(`a${i}.txt`, await writeBlob(ctx, `add-side-${i}`)));
  }
  return { diff: { changes: [...deletes, ...adds] }, uniqueIdCount: deleteCount + addCount };
}

describe('hydrateFingerprints', () => {
  describe('Given more ids than the ioBound limit, none already known', () => {
    describe('When hydrateFingerprints runs', () => {
      it('Then the total object loads in flight never exceed the ioBound limit', async () => {
        // Arrange — an explicit ioBound distinct from cpuBound so a bucket-swap
        // regression fails loudly, and small enough that a doubled ceiling
        // (a regression back to per-arm pools) is unambiguous against the
        // single shared pool `hydrateFingerprints` now always uses.
        const ioBound = 4;
        const base = await buildSeededContext();
        const ctx: Ctx = { ...base, concurrency: { cpuBound: 1, ioBound } };
        const ids = await Promise.all(
          Array.from({ length: 12 }, (_unused, i) => writeBlob(ctx, `blob-${i}`)),
        );
        let inFlight = 0;
        let maxInFlight = 0;
        const realReadBlob = readBlobMod.readBlob;
        const spy = vi
          .spyOn(readBlobMod, 'readBlob')
          .mockImplementation(async (spyCtx, id, opts) => {
            inFlight += 1;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await Promise.resolve();
            inFlight -= 1;
            return realReadBlob(spyCtx, id, opts);
          });
        const sut = hydrateFingerprints;

        // Act
        try {
          await sut(ctx, ids, new Map());

          // Assert — reaches exactly the shared bound, proving one pool
          // serves the whole id list rather than merely staying at-or-under
          // it (which a smaller, coincidental sample could also satisfy).
          expect(maxInFlight).toBe(ioBound);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  describe('Given an id already present in `known`', () => {
    describe('When hydrateFingerprints runs', () => {
      it('Then that id is never read again, and the returned map still carries it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const knownId = await writeBlob(ctx, 'already-known');
        const freshId = await writeBlob(ctx, 'freshly-hydrated');
        const known = new Map([[knownId, { chunkMap: new Map(), size: 999 }]]);
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await hydrateFingerprints(ctx, [knownId, freshId], known);

        // Assert
        expect(readSpy.mock.calls.some(([, id]) => id === knownId)).toBe(false);
        expect(result.get(knownId)).toEqual({ chunkMap: new Map(), size: 999 });
        expect(result.get(freshId)).toBeDefined();
        readSpy.mockRestore();
      });
    });
  });
});

describe('detect-similarity-renames — size gate', () => {
  describe('Given more than SIZE_GATE_MIN_IDS unique ids, with one delete whose size no add can reach', () => {
    describe('When detectSimilarityRenames runs', () => {
      it('Then the size-incompatible delete is never passed to readBlob', async () => {
        // Arrange — 9 same-length delete/add pairs (18 mutually size-compatible
        // ids) plus one wildly larger outlier delete: 19 unique ids total,
        // above SIZE_GATE_MIN_IDS (16), so the size gate actually runs.
        const ctx = await buildSeededContext();
        const { diff, uniqueIdCount } = await buildDistinctPairDiff(ctx, 9, 9);
        const outlierId = await writeBlob(ctx, 'y'.repeat(5000));
        const withOutlier: TreeDiff = {
          changes: [...diff.changes, deleteChange('outlier.txt', outlierId)],
        };
        expect(uniqueIdCount + 1).toBeGreaterThan(16);

        const seenIds: ObjectId[] = [];
        const realReadBlob = readBlobMod.readBlob;
        const spy = vi
          .spyOn(readBlobMod, 'readBlob')
          .mockImplementation(async (spyCtx, id, opts) => {
            seenIds.push(id);
            return realReadBlob(spyCtx, id, opts);
          });

        // Act
        try {
          await detectSimilarityRenames(ctx, withOutlier);
        } finally {
          spy.mockRestore();
        }

        // Assert
        expect(seenIds).not.toContain(outlierId);
      });
    });
  });

  describe('Given exactly SIZE_GATE_MIN_IDS unique ids', () => {
    describe('When detectSimilarityRenames runs', () => {
      it('Then the size read is never called', async () => {
        // Arrange — 8 deletes + 8 adds = 16 unique ids, exactly the gate.
        const ctx = await buildSeededContext();
        const { diff } = await buildDistinctPairDiff(ctx, 8, 8);
        const spy = vi.spyOn(readObjectMod, 'readDeclaredObjectSize');

        // Act — snapshot the call count BEFORE mockRestore, which clears it.
        let callCount = 0;
        try {
          await detectSimilarityRenames(ctx, diff);
          callCount = spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }

        // Assert
        expect(callCount).toBe(0);
      });
    });
  });

  describe('Given SIZE_GATE_MIN_IDS + 1 unique ids', () => {
    describe('When detectSimilarityRenames runs', () => {
      it('Then the size read is called exactly once per unique id', async () => {
        // Arrange — 8 deletes + 9 adds = 17 unique ids, one past the gate.
        const ctx = await buildSeededContext();
        const { diff, uniqueIdCount } = await buildDistinctPairDiff(ctx, 8, 9);
        const spy = vi.spyOn(readObjectMod, 'readDeclaredObjectSize');

        // Act — snapshot the call count BEFORE mockRestore, which clears it.
        let callCount = 0;
        try {
          await detectSimilarityRenames(ctx, diff);
          callCount = spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }

        // Assert
        expect(callCount).toBe(uniqueIdCount);
      });
    });
  });
});
