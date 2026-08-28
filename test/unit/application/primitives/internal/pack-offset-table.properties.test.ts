import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ArtefactLoad } from '../../../../../src/application/primitives/internal/pack-artefact-source.js';
import {
  nextOffsetForEntry,
  resolveOffsetTable,
} from '../../../../../src/application/primitives/internal/pack-offset-table.js';
import { packPositionMap } from '../../../../../src/application/primitives/internal/pack-positions.js';
import type { ObjectId } from '../../../../../src/domain/objects/object-id.js';
import {
  type PackRevIndex,
  parsePackIndex,
  parsePackRevIndex,
} from '../../../../../src/domain/storage/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  arbPackIndexWriterEntries,
  buildRevIndex,
  buildTestIndex,
  type TestIndexEntry,
} from '../../../domain/storage/arbitraries.js';

const DIGEST_LENGTH = 20;

const silentCtx = { logger: undefined } as unknown as Context;

const absentLoad = async (): Promise<ArtefactLoad<PackRevIndex>> => ({ kind: 'absent' });

/** An arbitrary, internally-consistent pack layout: distinct oids AND
 *  distinct offsets, non-empty — the shape a real pack's `.idx` carries. */
function arbPackLayout(): fc.Arbitrary<TestIndexEntry[]> {
  return arbPackIndexWriterEntries(40)
    .filter((entries) => entries.length > 0)
    .map((entries) =>
      entries.map((e) => ({ id: e.id as ObjectId, offset: e.offset, crc32: e.crc32 })),
    );
}

describe('pack successor lookup — lazy vs sorted equivalence', () => {
  describe('Given an arbitrary pack layout with a usable, correct .rev', () => {
    describe('When the successor of every entry is requested', () => {
      it('Then both the lazy .rev-backed path and the sorted fallback path agree with an independent successor oracle', async () => {
        await fc.assert(
          fc.asyncProperty(arbPackLayout(), async (entries) => {
            // Arrange — two tables over the SAME index, each forced onto a
            // DIFFERENT arm by its `loadRevIndex` fixture: one answers via a
            // binary search through .idx+.rev, the other via a plain sort of
            // the .idx's own offsets. `usableLoad`/`absentLoad` are what pin
            // which arm actually ran — resolveOffsetTable itself decides the
            // arm from artefact presence, so without asserting `.kind` a
            // degrade-to-sorted fallback inside the "lazy" path could pass
            // this property while never exercising the lazy code at all.
            const index = parsePackIndex(buildTestIndex(entries), DIGEST_LENGTH);
            const correctBody = Array.from(packPositionMap(index));
            const revBytes = buildRevIndex({
              hashId: 1,
              digestLength: DIGEST_LENGTH,
              body: correctBody,
              packChecksum: new Uint8Array(DIGEST_LENGTH),
            });
            const rev = parsePackRevIndex(revBytes, DIGEST_LENGTH, entries.length);
            const usableLoad = async (): Promise<ArtefactLoad<PackRevIndex>> => ({
              kind: 'usable',
              value: rev,
              bytes: new Uint8Array(0),
            });
            const maxOffset = Math.max(...entries.map((e) => e.offset));
            const packFileSize = maxOffset + DIGEST_LENGTH + 8;
            const trailerStart = packFileSize - DIGEST_LENGTH;

            const lazyTable = await resolveOffsetTable(
              silentCtx,
              'p',
              index,
              usableLoad,
              packFileSize,
              trailerStart,
            );
            const sortedTable = await resolveOffsetTable(
              silentCtx,
              'p',
              index,
              absentLoad,
              packFileSize,
              trailerStart,
            );

            // Assert — each table took the arm its fixture forces.
            expect(lazyTable.kind).toBe('lazy');
            expect(sortedTable.kind).toBe('sorted');

            // Independent oracle: the successor of an offset is the
            // next-higher offset among the GENERATED entries (or
            // trailerStart for the highest one), computed straight from
            // `entries` — never through resolveOffsetTable/parsePackIndex,
            // so it cannot share a bug with the SUT it is checking.
            // arbPackLayout guarantees distinct offsets, so the rank lookup
            // is unambiguous.
            const ascendingOffsets = entries.map((e) => e.offset).sort((a, b) => a - b);
            const independentSuccessor = (offset: number): number => {
              const rank = ascendingOffsets.indexOf(offset);
              return rank === ascendingOffsets.length - 1
                ? trailerStart
                : (ascendingOffsets[rank + 1] as number);
            };

            // Act + Assert
            for (const entry of entries) {
              const expected = independentSuccessor(entry.offset);
              expect(nextOffsetForEntry(lazyTable, entry.offset)).toBe(expected);
              expect(nextOffsetForEntry(sortedTable, entry.offset)).toBe(expected);
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
