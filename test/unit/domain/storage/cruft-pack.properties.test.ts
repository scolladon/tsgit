import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compareBytes, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import {
  parseCruftMtimes,
  serializeCruftMtimes,
} from '../../../../src/domain/storage/cruft-pack.js';
import { sortPackIndexEntries } from '../../../../src/domain/storage/pack-order.js';
import { packIndexEntriesOf } from '../../../fixtures/storage/pack-index-entries.js';
import { arbPackIndexWriterEntries } from './arbitraries.js';

describe('cruft-pack properties', () => {
  describe('Given an arbitrary object count, u32 mtime vector and hash width', () => {
    describe('When parseCruftMtimes(serializeCruftMtimes(x)) round-trips', () => {
      it('Then it reproduces the same oid -> mtime map', () => {
        // Arrange + Act + Assert
        const sut = serializeCruftMtimes;

        fc.assert(
          fc.property(
            // digestLength is drawn FIRST: the entries' own oid hex width
            // must match it, since serializeCruftMtimes now decodes the oid
            // hex back out of the digestLength-wide slab rather than
            // retaining the original id string.
            fc.constantFrom<20 | 32>(20, 32).chain((digestLength) =>
              arbPackIndexWriterEntries(30, digestLength === 32 ? 64 : 40).chain((entries) =>
                fc.tuple(
                  fc.constant(digestLength),
                  fc.constant(entries),
                  fc.array(fc.integer({ min: 0, max: 0xffffffff }), {
                    minLength: entries.length,
                    maxLength: entries.length,
                  }),
                ),
              ),
            ),
            ([digestLength, entries, mtimes]) => {
              const packChecksum = new Uint8Array(digestLength).fill(0xab);
              // Keyed by emission ordinal now: `entries` IS emission order, so
              // an ordinal indexes it directly and no oid is decoded. The
              // oid-keyed map survives for the round-trip assertion, which
              // reads back through `parseCruftMtimes`' own oid-keyed result.
              const mtimeByOid = new Map<string, number>(
                entries.map((entry, i) => [entry.id, mtimes[i]!]),
              );
              const mtimeAt = (ordinal: number): number => mtimes[ordinal]!;
              const sorted = sortPackIndexEntries(packIndexEntriesOf(entries, digestLength));

              const bytes = sut(sorted, packChecksum, mtimeAt);
              const oidsInIndexOrder = [...entries]
                .sort((a, b) => compareBytes(hexToBytes(a.id), hexToBytes(b.id)))
                .map((entry) => entry.id as ObjectId);

              const result = parseCruftMtimes(bytes, oidsInIndexOrder);

              expect(result.size).toBe(oidsInIndexOrder.length);
              for (const oid of oidsInIndexOrder) {
                expect(result.get(oid)).toBe(mtimeByOid.get(oid));
              }
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });
});
