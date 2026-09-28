import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildFingerprint,
  countCopied,
  denseFingerprint,
  estimateSimilarity,
  MAX_SCORE,
  packFingerprint,
  toSimilarityPercent,
} from '../../../../src/domain/diff/similarity.js';
import { arbBlobBytes } from './arbitraries.js';
import { buildChunkMap, countSrcCopied } from './support/spanhash-map-oracle.js';

/** Mirrors git's `HASHBASE` (`diffcore-delta.c`) — a prime between 2^16..2^17. */
const HASHBASE = 107927;

/** Text peppered with CRLF pairs — exercises the CR-of-CRLF skip on every
 *  other chunk boundary, not just the plain-LF case `arbBlobBytes` covers. */
function arbCrlfHeavyText(): fc.Arbitrary<Uint8Array> {
  return fc
    .array(fc.constantFrom('ab', '\r\n', 'x\r\n', '\n'), { minLength: 1, maxLength: 80 })
    .map((parts) => new TextEncoder().encode(parts.join('')));
}

/** Byte runs with no LF at all — every chunk boundary comes from the
 *  MAX_CHUNK_LEN (64) forced flush, never the LF shortcut. */
function arb64ByteRunsNoLf(): fc.Arbitrary<Uint8Array> {
  return fc
    .array(fc.integer({ min: 1, max: 255 }), { minLength: 1, maxLength: 600 })
    .map((codes) => new Uint8Array(codes));
}

/** Sizes straddling HASHBASE — the exact dispatch boundary between
 *  `packFingerprint` and `denseFingerprint`. Weighted low: generating tens of
 *  thousands of bytes per draw is the most expensive lens. */
function arbStraddlingHashbase(): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ minLength: HASHBASE - 5, maxLength: HASHBASE + 5 });
}

/** Every content shape the merge-scan and the pack/dense split need to agree
 *  on: plain small blobs, CRLF-heavy text, long LF-free runs, and sizes
 *  straddling the pack/dense dispatch threshold. */
function arbFingerprintContent(): fc.Arbitrary<Uint8Array> {
  return fc.oneof(
    { weight: 6, arbitrary: arbBlobBytes() },
    { weight: 6, arbitrary: arbCrlfHeavyText() },
    { weight: 6, arbitrary: arb64ByteRunsNoLf() },
    { weight: 1, arbitrary: arbStraddlingHashbase() },
  );
}

describe('similarity properties', () => {
  describe('Given an arbitrary blob', () => {
    describe('When estimateSimilarity(x, x) is called (identity)', () => {
      it('Then returns MAX_SCORE for any non-empty blob', () => {
        // Arrange
        const sut = estimateSimilarity;
        fc.assert(
          fc.property(arbBlobBytes(), (x) => {
            // Act
            const result = sut(x, x);

            // Assert
            expect(result).toBe(MAX_SCORE);
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('When estimateSimilarity(a, b) is called (bounded)', () => {
      it('Then result is always in [0, MAX_SCORE]', () => {
        // Arrange
        const sut = estimateSimilarity;
        fc.assert(
          fc.property(arbBlobBytes(), arbBlobBytes(), (a, b) => {
            // Act
            const result = sut(a, b);

            // Assert
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(MAX_SCORE);
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('When toSimilarityPercent is called (monotone non-decreasing)', () => {
      it('Then higher score always yields equal or higher percent', () => {
        // Arrange
        const sut = toSimilarityPercent;
        fc.assert(
          fc.property(
            fc.integer({ min: 0, max: MAX_SCORE }),
            fc.integer({ min: 0, max: MAX_SCORE }),
            (a, b) => {
              const lo = Math.min(a, b);
              const hi = Math.max(a, b);

              // Act
              const pctLo = sut(lo);
              const pctHi = sut(hi);

              // Assert
              expect(pctLo).toBeLessThanOrEqual(pctHi);
            },
          ),
          { numRuns: 100 },
        );
      });

      it('Then result is always <= 100', () => {
        // Arrange
        const sut = toSimilarityPercent;
        fc.assert(
          fc.property(fc.integer({ min: 0, max: MAX_SCORE }), (score) => {
            // Act
            const result = sut(score);

            // Assert
            expect(result).toBeLessThanOrEqual(100);
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('When dissimilarity identity is computed', () => {
      it('Then MAX_SCORE - estimateSimilarity(x, x) is always 0', () => {
        // Arrange
        const sut = estimateSimilarity;
        fc.assert(
          fc.property(arbBlobBytes(), (x) => {
            // Act
            const result = MAX_SCORE - sut(x, x);

            // Assert
            expect(result).toBe(0);
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('When buildFingerprint is called (bucket range and ordering)', () => {
      it('Then hashes are ascending, distinct integers in [0, HASHBASE), for either content kind', () => {
        // Arrange
        const sut = buildFingerprint;
        fc.assert(
          fc.property(arbFingerprintContent(), fc.constantFrom('text', 'binary'), (bytes, kind) => {
            // Act
            const { hashes } = sut(bytes, kind);

            // Assert
            for (let i = 0; i < hashes.length; i++) {
              const hash = hashes[i] as number;
              expect(Number.isInteger(hash)).toBe(true);
              expect(hash).toBeGreaterThanOrEqual(0);
              expect(hash).toBeLessThan(HASHBASE);
              if (i > 0) expect(hash).toBeGreaterThan(hashes[i - 1] as number);
            }
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('When countCopied is compared against the independent Map oracle', () => {
      it('Then the typed merge-scan matches the oracle exactly, including a src/dst kind mismatch', () => {
        // Arrange — srcKind and dstKind are drawn INDEPENDENTLY: each side of
        // a real pair is sniffed on its own (`countSpanhashChanges`'s
        // default, undefined override), so a src/dst content-kind mismatch is
        // a real scenario, not just a same-kind pair repeated twice.
        const sut = countCopied;
        fc.assert(
          fc.property(
            arbFingerprintContent(),
            arbFingerprintContent(),
            fc.constantFrom('text', 'binary'),
            fc.constantFrom('text', 'binary'),
            (src, dst, srcKind, dstKind) => {
              // Act
              const result = sut(packFingerprint(src, srcKind), packFingerprint(dst, dstKind));
              const expected = countSrcCopied(
                buildChunkMap(src, srcKind),
                buildChunkMap(dst, dstKind),
              );

              // Assert
              expect(result).toBe(expected);
            },
          ),
          { numRuns: 100 },
        );
      });
    });

    describe('When packFingerprint and denseFingerprint are both called on the same input', () => {
      it('Then they produce identical hashes and counts', () => {
        // Arrange — packFingerprint is the sut; denseFingerprint is the
        // alternate dispatch path checked for parity against it.
        const sut = packFingerprint;
        fc.assert(
          fc.property(arbFingerprintContent(), fc.constantFrom('text', 'binary'), (data, kind) => {
            // Act
            const packed = sut(data, kind);
            const dense = denseFingerprint(data, kind);

            // Assert
            expect(Array.from(dense.hashes)).toEqual(Array.from(packed.hashes));
            expect(Array.from(dense.counts)).toEqual(Array.from(packed.counts));
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
