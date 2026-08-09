import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import {
  lookupMultiPackIndex,
  midxOidAt,
  parseMultiPackIndex,
} from '../../../../src/domain/storage/midx.js';
import { arbMidxSpec, arbObjectId, buildMidx } from './arbitraries.js';

describe('midx properties', () => {
  describe('Given an arbitrary midx spec', () => {
    describe('When building then parsing', () => {
      it('Then it recovers the spec packs, oids and offsets', () => {
        // Arrange + Act + Assert
        const sut = parseMultiPackIndex;

        fc.assert(
          fc.property(arbMidxSpec(), (spec) => {
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

        fc.assert(
          fc.property(
            fc.uint8Array({ minLength: 0, maxLength: 4096 }),
            fc.constantFrom(20, 32),
            (bytes, digestLength) => {
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
              expect(
                result.oidLookupOffset + result.objectCount * digestLength,
              ).toBeLessThanOrEqual(bytes.length);
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
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });
});
