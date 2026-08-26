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
      it('Then the lazy .rev-backed path agrees with the sorted fallback path for every entry', async () => {
        await fc.assert(
          fc.asyncProperty(arbPackLayout(), async (entries) => {
            // Arrange — two independently derived tables over the SAME index:
            // one answers via a binary search through .idx+.rev, the other
            // via a plain sort of the .idx's own offsets.
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

            // Act + Assert
            for (const entry of entries) {
              expect(nextOffsetForEntry(lazyTable, entry.offset)).toBe(
                nextOffsetForEntry(sortedTable, entry.offset),
              );
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
