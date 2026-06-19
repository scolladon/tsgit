import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BREAK_SCORE,
  DEFAULT_MERGE_SCORE,
  DEFAULT_RENAME_THRESHOLD,
  estimateSimilarity,
  MAX_SCORE,
  toSimilarityPercent,
} from '../../../../src/domain/diff/similarity.js';

const enc = new TextEncoder();

/**
 * Pinned fixture: 10 identical lines of 'abcdefghij'*5+'\n' (51 bytes each),
 * line 5 replaced with 'X'*65+'\n' (66 bytes).
 * Verified against git 2.54.0 (GIT_CONFIG_NOSYSTEM=1, signing off, scrubbed GIT_*):
 * `git diff --no-ext-diff -M HEAD~1 HEAD --name-status` → R087.
 */
function makeR087Fixture(): { readonly src: Uint8Array; readonly dst: Uint8Array } {
  const line = enc.encode(`${'abcdefghij'.repeat(5)}\n`); // 51 bytes
  const replacement = enc.encode(`${'X'.repeat(65)}\n`); // 66 bytes
  const srcParts = Array.from({ length: 10 }, () => line);
  const dstParts = Array.from({ length: 10 }, (_, i) => (i === 4 ? replacement : line));
  const concatParts = (parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  };
  return { src: concatParts(srcParts), dst: concatParts(dstParts) };
}

describe('similarity', () => {
  describe('MAX_SCORE', () => {
    describe('Given the constant, When read', () => {
      it('Then equals 60000', () => {
        // Arrange
        const sut = MAX_SCORE;

        // Act / Assert
        expect(sut).toBe(60000);
      });
    });
  });

  describe('DEFAULT_RENAME_THRESHOLD', () => {
    describe('Given the constant, When read', () => {
      it('Then equals 30000 (50% of MAX_SCORE)', () => {
        // Arrange
        const sut = DEFAULT_RENAME_THRESHOLD;

        // Act / Assert
        expect(sut).toBe(30000);
      });
    });
  });

  describe('DEFAULT_BREAK_SCORE', () => {
    describe('Given the constant, When read', () => {
      it('Then equals 30000 (50% of MAX_SCORE)', () => {
        // Arrange
        const sut = DEFAULT_BREAK_SCORE;

        // Act / Assert
        expect(sut).toBe(30000);
      });
    });
  });

  describe('DEFAULT_MERGE_SCORE', () => {
    describe('Given the constant, When read', () => {
      it('Then equals 36000 (60% of MAX_SCORE)', () => {
        // Arrange
        const sut = DEFAULT_MERGE_SCORE;

        // Act / Assert
        expect(sut).toBe(36000);
      });
    });
  });

  describe('toSimilarityPercent', () => {
    describe('Given score MAX_SCORE, When toSimilarityPercent is called', () => {
      it('Then returns 100', () => {
        // Arrange
        const score = MAX_SCORE;

        // Act
        const result = toSimilarityPercent(score);

        // Assert
        expect(result).toBe(100);
      });
    });

    describe('Given score 0, When toSimilarityPercent is called', () => {
      it('Then returns 0', () => {
        // Arrange
        const score = 0;

        // Act
        const result = toSimilarityPercent(score);

        // Assert
        expect(result).toBe(0);
      });
    });

    describe('Given score 59999 (one below MAX_SCORE), When toSimilarityPercent is called', () => {
      it('Then returns 99 (truncated, not rounded)', () => {
        // Arrange
        const score = 59999;

        // Act
        const result = toSimilarityPercent(score);

        // Assert
        expect(result).toBe(99);
      });
    });

    describe('Given score 52200 (the lower bound of 87%), When toSimilarityPercent is called', () => {
      it('Then returns 87 (truncated)', () => {
        // Arrange
        const score = 52200;

        // Act
        const result = toSimilarityPercent(score);

        // Assert
        expect(result).toBe(87);
      });
    });

    describe('Given score 52799 (the upper bound of 87%), When toSimilarityPercent is called', () => {
      it('Then returns 87 (truncated, not 88)', () => {
        // Arrange
        const score = 52799;

        // Act
        const result = toSimilarityPercent(score);

        // Assert
        expect(result).toBe(87);
      });
    });
  });

  describe('estimateSimilarity', () => {
    describe('Given both src and dst are empty, When estimateSimilarity is called', () => {
      it('Then returns MAX_SCORE (both-empty guard)', () => {
        // Arrange
        const src = new Uint8Array(0);
        const dst = new Uint8Array(0);

        // Act
        const result = estimateSimilarity(src, dst);

        // Assert
        expect(result).toBe(MAX_SCORE);
      });
    });

    describe('Given src is empty and dst is non-empty, When estimateSimilarity is called', () => {
      it('Then returns 0 (empty src contributes nothing)', () => {
        // Arrange
        const src = new Uint8Array(0);
        const dst = enc.encode('hello world');

        // Act
        const result = estimateSimilarity(src, dst);

        // Assert
        expect(result).toBe(0);
      });
    });

    describe('Given src is non-empty and dst is empty, When estimateSimilarity is called', () => {
      it('Then returns 0 (empty dst has no spans to match)', () => {
        // Arrange
        const src = enc.encode('hello world');
        const dst = new Uint8Array(0);

        // Act
        const result = estimateSimilarity(src, dst);

        // Assert
        expect(result).toBe(0);
      });
    });

    describe('Given src and dst are identical, When estimateSimilarity is called', () => {
      it('Then returns MAX_SCORE', () => {
        // Arrange
        const content = enc.encode('hello world this is a test file\n'.repeat(5));
        const src = content;
        const dst = content;

        // Act
        const result = estimateSimilarity(src, dst);

        // Assert
        expect(result).toBe(MAX_SCORE);
      });
    });

    describe('Given src and dst are provably disjoint (no shared 4-byte windows), When estimateSimilarity is called', () => {
      it('Then returns 0', () => {
        // Arrange — XOR complement guarantees no shared 4-grams
        const base = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
        const flipped = new Uint8Array(base.map((b) => b ^ 0xff));
        const src = new Uint8Array([...base, ...base, ...base, ...base]); // 1024 bytes
        const dst = new Uint8Array([...flipped, ...flipped, ...flipped, ...flipped]);

        // Act
        const result = estimateSimilarity(src, dst);

        // Assert
        expect(result).toBe(0);
      });
    });

    describe('Given the pinned 1-of-10-lines-changed fixture (git 2.54.0 → R087), When estimateSimilarity is called', () => {
      it('Then toSimilarityPercent(estimateSimilarity) returns exactly 87', () => {
        // Arrange — fixture verified against real git:
        // old.txt: 10 lines of 'abcdefghij'*5+'\n' (51 bytes each, 510 total)
        // new.txt: same but line 5 replaced with 'X'*65+'\n' (66 bytes, 525 total)
        // `git diff --no-ext-diff -M HEAD~1 HEAD --name-status` → R087
        const { src, dst } = makeR087Fixture();

        // Act
        const score = estimateSimilarity(src, dst);
        const result = toSimilarityPercent(score);

        // Assert
        expect(result).toBe(87);
      });

      it('Then raw score is in the range [52200, 52800) corresponding to 87%', () => {
        // Arrange
        const { src, dst } = makeR087Fixture();

        // Act
        const result = estimateSimilarity(src, dst);

        // Assert — exact score (not range) to kill arithmetic mutants
        // score must satisfy: (score * 100 / 60000) | 0 === 87
        // i.e. 52200 <= score < 52800
        expect(toSimilarityPercent(result)).toBe(87);
        expect(result).toBeGreaterThanOrEqual(52200);
        expect(result).toBeLessThan(52800);
      });
    });

    describe('Given size-asymmetric blobs (src is 510 bytes, dst is 525 bytes), When estimateSimilarity is called', () => {
      it('Then score uses max(src_size, dst_size) as denominator', () => {
        // Arrange — verify the score denominator is 525 (max_size), not 510 (src_size)
        const { src, dst } = makeR087Fixture();
        const maxSize = Math.max(src.length, dst.length);

        // Act
        const score = estimateSimilarity(src, dst);

        // Assert — if denominator were src_size (510), score would be > 52800
        // With denominator max_size (525), score is in [52200, 52800)
        expect(score).toBeLessThanOrEqual((MAX_SCORE * dst.length) / maxSize);
      });
    });

    describe('Given dissimilarity identity (estimateSimilarity(x, x)), When estimateSimilarity is called', () => {
      it('Then MAX_SCORE minus the result is 0', () => {
        // Arrange
        const content = enc.encode(`${'abcdefghij'.repeat(10)}\n`);

        // Act
        const score = estimateSimilarity(content, content);
        const result = MAX_SCORE - score;

        // Assert
        expect(result).toBe(0);
      });
    });
  });
});
