import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import { bitmapEntryHeaders, parsePackBitmap } from '../../../../src/domain/storage/bitmap.js';
import { arbBitmapSpec, buildBitmap } from './arbitraries.js';

describe('bitmap properties', () => {
  describe('Given an arbitrary bitmap spec', () => {
    describe('When building then parsing', () => {
      it('Then it reproduces every header field and bitmapEntryHeaders reproduces every entry', () => {
        // Arrange + Act + Assert
        const sut = parsePackBitmap;

        fc.assert(
          fc.property(arbBitmapSpec(), (spec) => {
            const result = sut(buildBitmap(spec), spec.digestLength);

            expect(result.version).toBe(1);
            expect(result.optionFlags).toBe(spec.optionFlags);
            expect(result.entryCount).toBe(spec.entries.length);
            expect(result.digestLength).toBe(spec.digestLength);
            expect(result.checksum).toEqual(spec.checksum);
            result.typeStreams.forEach((stream, i) => {
              expect(stream.bitSize).toBe(spec.typeStreams[i]!.bitSize);
            });

            const headers = bitmapEntryHeaders(result);
            expect(headers.length).toBe(spec.entries.length);
            headers.forEach((header, i) => {
              const entry = spec.entries[i]!;
              expect(header.position).toBe(entry.position);
              expect(header.xorOffset).toBe(entry.xorOffset);
              expect(header.flags).toBe(entry.flags);
              expect(header.stream.bitSize).toBe(entry.bitSize);
            });
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary byte string up to 8 KiB', () => {
    describe('When parsing as a pack bitmap', () => {
      it('Then it either parses or refuses with a check from the closed union — never a RangeError, and every accepted bound lies inside the buffer', () => {
        // Arrange + Act + Assert
        const sut = parsePackBitmap;

        // Raw bytes alone almost never survive the signature gate, so half the
        // runs start from a VALID built bitmap and corrupt a window of it — the
        // only generation that drives the parser into its later gates with
        // in-bounds-looking values.
        const rawBytes = fc
          .uint8Array({ minLength: 0, maxLength: 8192, size: 'max' })
          .chain((bytes) =>
            fc
              .constantFrom(20 as const, 32 as const)
              .map((digestLength) => ({ bytes, digestLength })),
          );

        const corruptedBuilt = arbBitmapSpec().chain((spec) => {
          const built = buildBitmap(spec);
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
            try {
              const result = sut(bytes, digestLength);
              for (const stream of result.typeStreams) {
                expect(stream.endOffset).toBeLessThanOrEqual(bytes.length);
              }
              expect(result.entriesOffset).toBeLessThanOrEqual(bytes.length);
            } catch (e) {
              const data = (e as TsgitError).data;
              expect(data.code).toBe('INVALID_PACK_BITMAP');
              if (data.code === 'INVALID_PACK_BITMAP') {
                expect(['size', 'signature', 'version', 'options', 'stream', 'entry']).toContain(
                  data.check,
                );
              }
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
