import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compareBytes, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import {
  parseCruftMtimes,
  serializeCruftMtimes,
} from '../../../../src/domain/storage/cruft-pack.js';
import { arbPackIndexWriterEntries } from './arbitraries.js';

describe('cruft-pack properties', () => {
  describe('Given an arbitrary object count, u32 mtime vector and hash width', () => {
    describe('When parseCruftMtimes(serializeCruftMtimes(x)) round-trips', () => {
      it('Then it reproduces the same oid -> mtime map', () => {
        // Arrange + Act + Assert
        const sut = serializeCruftMtimes;

        fc.assert(
          fc.property(
            arbPackIndexWriterEntries(30).chain((entries) =>
              fc.tuple(
                fc.constant(entries),
                fc.array(fc.integer({ min: 0, max: 0xffffffff }), {
                  minLength: entries.length,
                  maxLength: entries.length,
                }),
              ),
            ),
            fc.constantFrom<20 | 32>(20, 32),
            ([entries, mtimes], digestLength) => {
              const packChecksum = new Uint8Array(digestLength).fill(0xab);
              const mtimeByOid = new Map<string, number>(
                entries.map((entry, i) => [entry.id, mtimes[i]!]),
              );
              const mtimeOf = (oid: ObjectId): number => mtimeByOid.get(oid)!;

              const bytes = sut(entries, packChecksum, mtimeOf);
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
