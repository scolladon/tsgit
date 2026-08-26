import { describe, expect, it, vi } from 'vitest';
import { hydrateAndFingerprint } from '../../../../../src/application/primitives/detect-similarity-renames.js';
import * as readBlobMod from '../../../../../src/application/primitives/read-blob.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { AddChange } from '../../../../../src/domain/diff/diff-change.js';
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

describe('hydrateAndFingerprint', () => {
  describe('Given both the src and dst arms carry more ids than the ioBound limit', () => {
    describe('When hydrateAndFingerprint runs', () => {
      it('Then the total object loads in flight never exceed the ioBound limit', async () => {
        // Arrange — an explicit ioBound distinct from cpuBound so a bucket-swap
        // regression fails loudly, and small enough that the two-arm nesting
        // bug (2x the limit in flight) is unambiguous against a single shared
        // pool (at most the limit in flight).
        const ioBound = 4;
        const base = await buildSeededContext();
        const ctx: Ctx = { ...base, concurrency: { cpuBound: 1, ioBound } };
        const srcIds = await Promise.all(
          Array.from({ length: 6 }, (_unused, i) => writeBlob(ctx, `src-${i}`)),
        );
        const adds = await Promise.all(
          Array.from({ length: 6 }, async (_unused, i) =>
            addChange(`dst-${i}`, await writeBlob(ctx, `dst-${i}`)),
          ),
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
        const sut = hydrateAndFingerprint;

        // Act
        try {
          await sut(ctx, srcIds, adds);

          // Assert — not merely at-or-under the limit (which the pre-fix
          // nested-pool bug's own per-arm cap would also, coincidentally,
          // satisfy for a small enough sample); reaches exactly the shared
          // bound, proving one pool serves both arms.
          expect(maxInFlight).toBe(ioBound);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });
});
