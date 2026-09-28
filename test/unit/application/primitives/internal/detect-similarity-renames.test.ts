import { describe, expect, it, vi } from 'vitest';
import {
  detectSimilarityRenames,
  fingerprintKey,
  hydrateFingerprints,
  type PathedId,
  resolveOverridesFor,
} from '../../../../../src/application/primitives/detect-similarity-renames.js';
import type { SimilarityContentKindResolver } from '../../../../../src/application/primitives/internal/resolve-similarity-content-kind.js';
import * as readBlobMod from '../../../../../src/application/primitives/read-blob.js';
import * as readObjectMod from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type {
  AddChange,
  DeleteChange,
  ModifyChange,
  TreeDiff,
} from '../../../../../src/domain/diff/diff-change.js';
import * as similarityMod from '../../../../../src/domain/diff/similarity.js';
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

/** Wraps each id in an unattributed `PathedId` at a distinct throwaway
 *  path — `hydrateFingerprints` now keys its cache by (id, bucket), and an
 *  unattributed path always resolves to the 'sniff' bucket. */
const pathedIds = (ids: ReadonlyArray<ObjectId>): PathedId[] =>
  ids.map((id, index) => ({ id, path: `entry-${index}.bin` as FilePath }));

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
          await sut(ctx, pathedIds(ids), new Map());

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
        const knownFingerprint = { hashes: new Uint32Array(), counts: new Uint32Array() };
        const known = new Map([
          [fingerprintKey(knownId, 'sniff'), { fingerprint: knownFingerprint, size: 999 }],
        ]);
        const readSpy = vi.spyOn(readBlobMod, 'readBlob');

        // Act
        const result = await hydrateFingerprints(ctx, pathedIds([knownId, freshId]), known);

        // Assert
        expect(readSpy.mock.calls.some(([, id]) => id === knownId)).toBe(false);
        expect(result.get(fingerprintKey(knownId, 'sniff'))).toEqual({
          fingerprint: knownFingerprint,
          size: 999,
        });
        expect(result.get(fingerprintKey(freshId, 'sniff'))?.size).toBe('freshly-hydrated'.length);
        readSpy.mockRestore();
      });
    });
  });
});

describe('resolveOverridesFor', () => {
  describe('Given more distinct paths than the ioBound limit', () => {
    describe('When resolveOverridesFor runs', () => {
      it('Then the total overrideFor calls in flight never exceed the ioBound limit', async () => {
        // Arrange — an explicit ioBound, small enough that an unbounded
        // `Promise.all` regression (every path resolved at once) is
        // unambiguous against the bounded pool this call must use.
        const ioBound = 4;
        const base = await buildSeededContext();
        const ctx: Ctx = { ...base, concurrency: { cpuBound: 1, ioBound } };
        const entries: PathedId[] = Array.from({ length: 12 }, (_unused, i) => ({
          id: `id-${i}` as ObjectId,
          path: `entry-${i}.bin` as FilePath,
        }));
        let inFlight = 0;
        let maxInFlight = 0;
        const resolver: SimilarityContentKindResolver = {
          overrideFor: async () => {
            inFlight += 1;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await Promise.resolve();
            inFlight -= 1;
            return undefined;
          },
        };
        const sut = resolveOverridesFor;

        // Act
        await sut(ctx, resolver, entries);

        // Assert — reaches exactly the shared bound, proving the pool is
        // sized from `ctx` rather than merely staying at-or-under an
        // incidentally small ceiling.
        expect(maxInFlight).toBe(ioBound);
      });
    });
  });
});

// Comfortably above the break-attempt pass's own MINIMUM_BREAK_SIZE (400
// bytes) so every pair below is eligible to break.
const BREAK_MODIFY_BLOB_BYTES = 500;

const modifyChange = (path: string, oldId: ObjectId, newId: ObjectId): ModifyChange => ({
  type: 'modify',
  path: path as FilePath,
  oldId,
  newId,
  oldMode: FILE_MODE.REGULAR,
  newMode: FILE_MODE.REGULAR,
});

/** `count` modifies, each old/new pair maximally dissimilar (disjoint byte
 *  alphabets) so every one clears even the lowest non-zero break threshold.
 *  Every old blob's content is also DISTINCT (its own `i` prefix): content
 *  addressing would otherwise collapse `count` identical old blobs onto one
 *  object id, masking a regression where a later pair's read is served from
 *  an earlier pair's already-cached bytes instead of its own. */
async function buildBreakableModifyDiff(ctx: Ctx, count: number): Promise<TreeDiff> {
  const changes: ModifyChange[] = [];
  for (let i = 0; i < count; i += 1) {
    const oldId = await writeBlob(ctx, `old-${i}-${'a'.repeat(BREAK_MODIFY_BLOB_BYTES)}`);
    const newId = await writeBlob(ctx, `${i}-${'b'.repeat(BREAK_MODIFY_BLOB_BYTES)}`);
    changes.push(modifyChange(`f${i}.bin`, oldId, newId));
  }
  return { changes };
}

describe('detect-similarity-renames — break-rewrite blob retention', () => {
  describe('Given more breaking modifies than the ioBound limit', () => {
    describe('When detectSimilarityRenames runs with breakRewrites on', () => {
      it("Then a pair's own fingerprint build starts before the whole batch has finished reading (ordering, not a memory-release proof)", async () => {
        // Arrange — ioBound small and explicit so the bound below is
        // unambiguous; modifyCount well past it so a batch-then-process
        // regression (reading everything before scoring anything) is
        // distinguishable from per-pair fingerprint-and-drop.
        const ioBound = 3;
        const modifyCount = 12;
        const base = await buildSeededContext();
        const ctx: Ctx = { ...base, concurrency: { cpuBound: 1, ioBound } };
        const diff = await buildBreakableModifyDiff(ctx, modifyCount);

        let readCompletions = 0;
        const realReadBlob = readBlobMod.readBlob;
        const readSpy = vi
          .spyOn(readBlobMod, 'readBlob')
          .mockImplementation(async (spyCtx, id, opts) => {
            const result = await realReadBlob(spyCtx, id, opts);
            readCompletions += 1;
            return result;
          });

        let completionsAtFirstFingerprint: number | undefined;
        const realBuildFingerprint = similarityMod.buildFingerprint;
        const fingerprintSpy = vi
          .spyOn(similarityMod, 'buildFingerprint')
          .mockImplementation((data, kind) => {
            completionsAtFirstFingerprint ??= readCompletions;
            return realBuildFingerprint(data, kind);
          });
        const sut = detectSimilarityRenames;

        // Act
        try {
          await sut(ctx, diff, { breakRewrites: { score: 1, merge: 1 } });
        } finally {
          readSpy.mockRestore();
          fingerprintSpy.mockRestore();
        }

        // Assert — each of the (at most ioBound) concurrent workers can have
        // completed at most its own 2 reads (old + new) before triggering
        // its OWN first fingerprint build, so the first fingerprint anywhere
        // is bounded by ioBound * 2 reads, never by the full batch's
        // modifyCount * 2 — the shape a read-everything-then-score pass
        // would produce instead.
        expect(completionsAtFirstFingerprint).toBeLessThanOrEqual(ioBound * 2);
        expect(completionsAtFirstFingerprint).toBeLessThan(modifyCount * 2);
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

  describe('Given more than SIZE_GATE_MIN_IDS unique ids, with one add whose size no delete can reach', () => {
    describe('When detectSimilarityRenames runs', () => {
      it('Then the size-incompatible add is never passed to readBlob, and it stays an add', async () => {
        // Arrange — 9 same-length delete/add pairs (18 mutually size-compatible
        // ids) plus one wildly larger outlier add: 19 unique ids total, above
        // SIZE_GATE_MIN_IDS (16), so the size gate runs on the destination side too.
        const ctx = await buildSeededContext();
        const { diff, uniqueIdCount } = await buildDistinctPairDiff(ctx, 9, 9);
        const outlierId = await writeBlob(ctx, 'z'.repeat(5000));
        const withOutlier: TreeDiff = {
          changes: [...diff.changes, addChange('outlier.txt', outlierId)],
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
        let result: TreeDiff;
        try {
          result = await detectSimilarityRenames(ctx, withOutlier);
        } finally {
          spy.mockRestore();
        }

        // Assert
        expect(seenIds).not.toContain(outlierId);
        const outlierChange = result.changes.find((c) => c.type === 'add' && c.newId === outlierId);
        expect(outlierChange?.type).toBe('add');
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
