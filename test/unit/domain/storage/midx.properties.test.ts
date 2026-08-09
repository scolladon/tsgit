import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import {
  lookupMultiPackIndex,
  midxOidAt,
  midxReverseIndexAt,
  parseMultiPackIndex,
} from '../../../../src/domain/storage/midx.js';
import { arbMidxSpec, arbMidxSpecWithRev, arbObjectId, buildMidx } from './arbitraries.js';

describe('midx properties', () => {
  describe('Given an arbitrary midx spec carrying a reverse-index chunk', () => {
    describe('When building then parsing', () => {
      it('Then it recovers the spec packs, oids, offsets and reverse-index body', () => {
        // Arrange + Act + Assert
        const sut = parseMultiPackIndex;

        fc.assert(
          fc.property(arbMidxSpecWithRev(), (spec) => {
            const result = sut(buildMidx(spec), spec.digestLength);

            expect(result.version).toBe(spec.version);
            expect(result.hashVersion).toBe(spec.hashVersion);
            expect(result.digestLength).toBe(spec.digestLength);
            expect(result.numBaseFiles).toBe(spec.numBaseFiles);
            expect(result.packNames).toEqual(spec.packNames);
            expect(result.objectCount).toBe(spec.entries.length);

            for (const entry of spec.entries) {
              expect(lookupMultiPackIndex(result, entry.id)).toEqual({
                packIndex: entry.packIndex,
                offset: entry.offset,
              });
            }

            const expectedIds = [...spec.entries.map((entry) => entry.id)].sort();
            expect(
              Array.from({ length: result.objectCount }, (_, i) => midxOidAt(result, i)).sort(),
            ).toEqual(expectedIds);

            expect(result.reverseIndexOffset).not.toBeUndefined();
            for (let p = 0; p < result.objectCount; p += 1) {
              expect(midxReverseIndexAt(result, p)).toBe(spec.revBody![p]);
            }
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary midx spec and an oid outside it', () => {
    describe('When looking up the absent oid', () => {
      it('Then returns undefined', () => {
        // Arrange + Act + Assert
        const sut = lookupMultiPackIndex;

        fc.assert(
          fc.property(
            arbMidxSpec().chain((spec) =>
              arbObjectId(spec.digestLength === 20 ? 40 : 64)
                .filter((id) => !spec.entries.some((entry) => entry.id === id))
                .map((absentId) => ({ spec, absentId })),
            ),
            ({ spec, absentId }) => {
              const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

              const result = sut(midx, absentId);

              expect(result).toBeUndefined();
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary byte string up to 4 KiB', () => {
    describe('When parsing as a multi-pack index', () => {
      it('Then it either returns a value whose chunk offsets lie inside the buffer, or refuses — never a RangeError', () => {
        // Arrange + Act + Assert
        const sut = parseMultiPackIndex;

        // Raw bytes alone almost never survive the signature gate, so half
        // the runs start from a VALID built midx and corrupt a window of it —
        // the only generation that drives the parser into its deep gates
        // (chunk table, fanout, PNAM, LOFF) with in-bounds-looking values.
        const rawBytes = fc
          .uint8Array({ minLength: 0, maxLength: 4096, size: 'max' })
          .chain((bytes) =>
            fc.constantFrom(20 as const, 32 as const).map((digestLength) => ({
              bytes,
              digestLength,
            })),
          );
        const corruptedBuilt = arbMidxSpec().chain((spec) => {
          const built = buildMidx(spec);
          return fc
            .tuple(
              fc.nat({ max: Math.max(0, built.length - 1) }),
              fc.uint8Array({ minLength: 1, maxLength: 16 }),
            )
            .map(([start, patch]) => {
              const corrupted = built.slice();
              corrupted.set(patch.subarray(0, corrupted.length - start), start);
              return { bytes: corrupted, digestLength: spec.digestLength };
            });
        });

        fc.assert(
          fc.property(fc.oneof(rawBytes, corruptedBuilt), ({ bytes, digestLength }) => {
            let result: ReturnType<typeof sut> | undefined;
            try {
              result = sut(bytes, digestLength);
            } catch (e) {
              expect((e as TsgitError).data.code).toBe('INVALID_MULTI_PACK_INDEX');
              return;
            }

            expect(result.oidFanoutOffset).toBeGreaterThanOrEqual(0);
            expect(result.oidFanoutOffset + 1024).toBeLessThanOrEqual(bytes.length);
            expect(result.oidLookupOffset).toBeGreaterThanOrEqual(0);
            expect(result.oidLookupOffset + result.objectCount * digestLength).toBeLessThanOrEqual(
              bytes.length,
            );
            expect(result.objectOffsetsOffset).toBeGreaterThanOrEqual(0);
            expect(result.objectOffsetsOffset + result.objectCount * 8).toBeLessThanOrEqual(
              bytes.length,
            );
            if (result.largeOffsetsOffset !== undefined) {
              expect(result.largeOffsetsOffset).toBeGreaterThanOrEqual(0);
              expect(result.largeOffsetsOffset + result.largeOffsetCount * 8).toBeLessThanOrEqual(
                bytes.length,
              );
            }
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
