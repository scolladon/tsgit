import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import { compareBytes, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { sortPackIndexEntries } from '../../../../src/domain/storage/pack-order.js';
import {
  parsePackRevIndex,
  REV_HEADER_SIZE,
  revIndexPositionAt,
  serializePackRevIndex,
} from '../../../../src/domain/storage/rev-index.js';
import { packIndexEntriesOf } from '../../../fixtures/storage/pack-index-entries.js';
import { arbPackIndexWriterEntries, arbRevIndexSpec, buildRevIndex } from './arbitraries.js';

describe('rev-index properties', () => {
  describe('Given an arbitrary rev-index spec', () => {
    describe('When building then parsing', () => {
      it('Then it reproduces every header field and revIndexPositionAt reproduces every body word', () => {
        // Arrange + Act + Assert
        const sut = parsePackRevIndex;

        fc.assert(
          fc.property(arbRevIndexSpec(), (spec) => {
            const objectCount = spec.body.length;

            const result = sut(buildRevIndex(spec), spec.digestLength, objectCount);

            expect(result.version).toBe(1);
            expect(result.hashId).toBe(spec.hashId);
            expect(result.digestLength).toBe(spec.digestLength);
            expect(result.objectCount).toBe(objectCount);
            expect(result.packChecksum).toEqual(spec.packChecksum);

            for (let p = 0; p < objectCount; p += 1) {
              expect(revIndexPositionAt(result, p)).toBe(spec.body[p]);
            }
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary byte string up to 4 KiB', () => {
    describe('When parsing as a pack reverse index', () => {
      it('Then it either parses or refuses with a check from the closed union — never a RangeError', () => {
        // Arrange + Act + Assert
        const sut = parsePackRevIndex;

        // Raw bytes alone almost never survive the signature gate, so half
        // the runs start from a VALID built rev-index and corrupt a window
        // of it — the only generation that drives the parser into its size
        // gate with in-bounds-looking values.
        const rawBytes = fc
          .uint8Array({ minLength: 0, maxLength: 4096, size: 'max' })
          .chain((bytes) =>
            fc.constantFrom(20 as const, 32 as const).chain((digestLength) =>
              fc.integer({ min: 0, max: 500 }).map((objectCount) => ({
                bytes,
                digestLength,
                objectCount,
              })),
            ),
          );

        const corruptedBuilt = arbRevIndexSpec().chain((spec) => {
          const built = buildRevIndex(spec);
          return fc
            .tuple(
              fc.nat({ max: Math.max(0, built.length - 1) }),
              fc.uint8Array({ minLength: 1, maxLength: 16 }),
            )
            .map(([start, patch]) => {
              const corrupted = built.slice();
              corrupted.set(patch.subarray(0, corrupted.length - start), start);
              return {
                bytes: corrupted,
                digestLength: spec.digestLength,
                objectCount: spec.body.length,
              };
            });
        });

        fc.assert(
          fc.property(
            fc.oneof(rawBytes, corruptedBuilt),
            ({ bytes, digestLength, objectCount }) => {
              try {
                sut(bytes, digestLength, objectCount);
              } catch (e) {
                const data = (e as TsgitError).data;
                expect(data.code).toBe('INVALID_PACK_REV_INDEX');
                if (data.code === 'INVALID_PACK_REV_INDEX') {
                  expect(['size', 'signature', 'version', 'hash-id']).toContain(data.check);
                }
              }
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary set of pack index writer entries with distinct oids and distinct offsets and a checksum of either width', () => {
    describe('When serializing then parsing', () => {
      it('Then every header field, the object count, the pack checksum and every revIndexPositionAt round-trip', () => {
        // Arrange + Act + Assert
        const sut = serializePackRevIndex;

        fc.assert(
          fc.property(
            arbPackIndexWriterEntries(30),
            fc.constantFrom<20 | 32>(20, 32),
            (entries, digestLength) => {
              const packChecksum = new Uint8Array(digestLength).fill(0xab);
              const objectCount = entries.length;
              const sorted = sortPackIndexEntries(packIndexEntriesOf(entries, digestLength));

              const bytes = sut(sorted, packChecksum);
              const rev = parsePackRevIndex(bytes, digestLength, objectCount);

              expect(rev.version).toBe(1);
              expect(rev.hashId).toBe(digestLength === 32 ? 2 : 1);
              expect(rev.digestLength).toBe(digestLength);
              expect(rev.objectCount).toBe(objectCount);
              expect(rev.packChecksum).toEqual(packChecksum);

              const body = Array.from({ length: objectCount }, (_, p) =>
                revIndexPositionAt(rev, p),
              );
              expect([...body].sort((a, b) => a - b)).toEqual(
                Array.from({ length: objectCount }, (_, i) => i),
              );

              // Body entries are ranks into the OID-ascending order (the
              // same order the `.idx` stores), not positions in `entries`.
              const byOid = [...entries].sort((a, b) =>
                compareBytes(hexToBytes(a.id), hexToBytes(b.id)),
              );
              const offsetsInBodyOrder = body.map((indexPosition) => byOid[indexPosition]!.offset);
              for (let i = 1; i < offsetsInBodyOrder.length; i += 1) {
                expect(offsetsInBodyOrder[i]!).toBeGreaterThan(offsetsInBodyOrder[i - 1]!);
              }
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary entry set and either digest width', () => {
    describe('When serializing', () => {
      it('Then it never throws and the size is exactly 12 + 4N + 2d', () => {
        // Arrange + Act + Assert
        const sut = serializePackRevIndex;

        fc.assert(
          fc.property(
            arbPackIndexWriterEntries(30),
            fc.constantFrom<20 | 32>(20, 32),
            (entries, digestLength) => {
              const packChecksum = new Uint8Array(digestLength);
              const sorted = sortPackIndexEntries(packIndexEntriesOf(entries, digestLength));

              const bytes = sut(sorted, packChecksum);

              expect(bytes.length).toBe(REV_HEADER_SIZE + 4 * entries.length + 2 * digestLength);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
