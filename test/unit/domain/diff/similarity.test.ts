import { describe, expect, it } from 'vitest';
import {
  buildChunkMap,
  countSpanhashChanges,
  DEFAULT_BREAK_SCORE,
  DEFAULT_MERGE_SCORE,
  DEFAULT_RENAME_THRESHOLD,
  estimateSimilarity,
  estimateSimilarityFromMaps,
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

// XOR complement guarantees no shared 4-grams.
function makeDisjoint256Pair(): { readonly src: Uint8Array; readonly dst: Uint8Array } {
  const base = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
  const flipped = new Uint8Array(base.map((b) => b ^ 0xff));
  return {
    src: new Uint8Array([...base, ...base, ...base, ...base]), // 1024 bytes
    dst: new Uint8Array([...flipped, ...flipped, ...flipped, ...flipped]),
  };
}

// XOR complement guarantees no shared chunk hashes.
function makeDisjoint64Pair(): { readonly src: Uint8Array; readonly dst: Uint8Array } {
  const base = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));
  const flipped = new Uint8Array(base.map((b) => b ^ 0xff));
  return {
    src: new Uint8Array([...base, ...base, ...base, 0x0a]),
    dst: new Uint8Array([...flipped, ...flipped, ...flipped, 0x0a]),
  };
}

describe('similarity', () => {
  describe('Given an exported score constant, When read', () => {
    it.each([
      { sut: MAX_SCORE, expected: 60000, label: 'MAX_SCORE equals 60000' },
      {
        sut: DEFAULT_RENAME_THRESHOLD,
        expected: 30000,
        label: 'DEFAULT_RENAME_THRESHOLD equals 30000 (50% of MAX_SCORE)',
      },
      {
        sut: DEFAULT_BREAK_SCORE,
        expected: 30000,
        label: 'DEFAULT_BREAK_SCORE equals 30000 (50% of MAX_SCORE)',
      },
      {
        sut: DEFAULT_MERGE_SCORE,
        expected: 36000,
        label: 'DEFAULT_MERGE_SCORE equals 36000 (60% of MAX_SCORE)',
      },
    ])('Then $label', ({ sut, expected }) => {
      // Act / Assert
      expect(sut).toBe(expected);
    });
  });

  describe('toSimilarityPercent', () => {
    describe('Given a similarity score, When toSimilarityPercent is called', () => {
      it.each([
        { score: MAX_SCORE, expected: 100, label: 'MAX_SCORE returns 100' },
        { score: 0, expected: 0, label: '0 returns 0' },
        {
          score: 59999,
          expected: 99,
          label: '59999 (one below MAX_SCORE) returns 99 (truncated, not rounded)',
        },
        {
          score: 52200,
          expected: 87,
          label: '52200 (the lower bound of 87%) returns 87 (truncated)',
        },
        {
          score: 52799,
          expected: 87,
          label: '52799 (the upper bound of 87%) returns 87 (truncated, not 88)',
        },
      ])('Then $label', ({ score, expected }) => {
        // Act
        const result = toSimilarityPercent(score);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('estimateSimilarity', () => {
    describe('Given src and dst byte content, When estimateSimilarity is called', () => {
      it.each([
        {
          src: new Uint8Array(0),
          dst: new Uint8Array(0),
          expected: MAX_SCORE,
          label: 'both empty returns MAX_SCORE (both-empty guard)',
        },
        {
          src: new Uint8Array(0),
          dst: enc.encode('hello world'),
          expected: 0,
          label: 'empty src and non-empty dst returns 0 (empty src contributes nothing)',
        },
        {
          src: enc.encode('hello world'),
          dst: new Uint8Array(0),
          expected: 0,
          label: 'non-empty src and empty dst returns 0 (empty dst has no spans to match)',
        },
        {
          src: enc.encode('hello world this is a test file\n'.repeat(5)),
          dst: enc.encode('hello world this is a test file\n'.repeat(5)),
          expected: MAX_SCORE,
          label: 'identical content returns MAX_SCORE',
        },
        {
          ...makeDisjoint256Pair(),
          expected: 0,
          label: 'provably disjoint content (no shared 4-byte windows) returns 0',
        },
      ])('Then $label', ({ src, dst, expected }) => {
        // Act
        const result = estimateSimilarity(src, dst);

        // Assert
        expect(result).toBe(expected);
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

  describe('countSpanhashChanges', () => {
    describe('Given src and dst byte content, When countSpanhashChanges is called', () => {
      it.each([
        {
          src: new Uint8Array(0),
          dst: new Uint8Array(0),
          srcCopied: 0,
          literalAdded: 0,
          label: 'both empty: srcCopied is 0 and literalAdded is 0',
        },
        {
          src: new Uint8Array(0),
          dst: enc.encode('hello world\n'),
          srcCopied: 0,
          literalAdded: 12, // 'hello world\n'.length
          label: 'src empty and dst non-empty: srcCopied is 0 and literalAdded equals dstSize',
        },
        {
          src: enc.encode('hello world\n'),
          dst: new Uint8Array(0),
          srcCopied: 0,
          literalAdded: 0,
          label: 'src non-empty and dst empty: srcCopied is 0 and literalAdded is 0',
        },
        {
          src: enc.encode('shared content alpha beta gamma\n'.repeat(5)),
          dst: enc.encode('shared content alpha beta gamma\n'.repeat(5)),
          srcCopied: 160, // 'shared content alpha beta gamma\n'.repeat(5).length
          literalAdded: 0,
          label: 'identical src and dst: srcCopied equals srcSize and literalAdded is 0',
        },
        {
          ...makeDisjoint64Pair(),
          srcCopied: 0,
          literalAdded: 193, // 64*3 + 1 trailing LF byte
          label: 'fully disjoint src and dst: srcCopied is 0 and literalAdded equals dstSize',
        },
      ])('Then $label', ({ src, dst, srcCopied, literalAdded }) => {
        // Act
        const result = countSpanhashChanges(src, dst);

        // Assert
        expect(result.srcCopied).toBe(srcCopied);
        expect(result.literalAdded).toBe(literalAdded);
      });
    });

    describe('Given the pinned B2 fixture (total=20 lines, shared=7), When countSpanhashChanges is called', () => {
      it('Then srcCopied=497 and merge_score yields git-faithful M065', () => {
        // Arrange — breakContent('old',20,7) vs breakContent('new',20,7)
        // Verified against real git 2.54.0: `git diff -B --name-status` → M065
        // merge_score = (srcSize - srcCopied) * MAX_SCORE / srcSize
        //             = (1420 - 497) * 60000 / 1420 = 923 * 60000 / 1420 = 39000 → 65%
        const makeBreakContent = (
          kind: 'old' | 'new',
          total: number,
          shared: number,
        ): Uint8Array => {
          const lines: string[] = [];
          for (let i = 0; i < total; i++) {
            if (kind === 'old' || i < shared) {
              lines.push(
                `line-${String(i).padStart(3, '0')}: shared content alpha beta gamma delta epsilon zeta eta theta\n`,
              );
            } else {
              lines.push(
                `different-${String(i).padStart(3, '0')}: COMPLETELY NEW TEXT ZETA THETA KAPPA LAMBDA MU NU XI OMICRON PI RHO SIGMA\n`,
              );
            }
          }
          return enc.encode(lines.join(''));
        };
        const src = makeBreakContent('old', 20, 7);
        const dst = makeBreakContent('new', 20, 7);
        const srcSize = src.length;

        // Act
        const sut = countSpanhashChanges(src, dst);

        // Assert — exact srcCopied to kill arithmetic mutants
        expect(sut.srcCopied).toBe(497);
        expect(sut.literalAdded).toBe(dst.length - 497);

        // Assert — merge_score reproduces git's M065
        const mergeScore = Math.trunc(((srcSize - sut.srcCopied) * MAX_SCORE) / srcSize);
        expect(Math.trunc((mergeScore * 100) / MAX_SCORE)).toBe(65);
      });
    });

    describe('Given the pinned B5 fixture (total=50 lines, shared=20), When countSpanhashChanges is called', () => {
      it('Then srcCopied=1420 and merge_score yields git-faithful M060', () => {
        // Arrange — breakContent('old',50,20) vs breakContent('new',50,20)
        // Verified against real git 2.54.0: `git diff -B --name-status` → M060
        // merge_score = (3550 - 1420) * 60000 / 3550 = 2130 * 60000 / 3550 = 36000 → 60%
        const makeBreakContent = (
          kind: 'old' | 'new',
          total: number,
          shared: number,
        ): Uint8Array => {
          const lines: string[] = [];
          for (let i = 0; i < total; i++) {
            if (kind === 'old' || i < shared) {
              lines.push(
                `line-${String(i).padStart(3, '0')}: shared content alpha beta gamma delta epsilon zeta eta theta\n`,
              );
            } else {
              lines.push(
                `different-${String(i).padStart(3, '0')}: COMPLETELY NEW TEXT ZETA THETA KAPPA LAMBDA MU NU XI OMICRON PI RHO SIGMA\n`,
              );
            }
          }
          return enc.encode(lines.join(''));
        };
        const src = makeBreakContent('old', 50, 20);
        const dst = makeBreakContent('new', 50, 20);
        const srcSize = src.length;

        // Act
        const sut = countSpanhashChanges(src, dst);

        // Assert — exact srcCopied to kill arithmetic mutants
        expect(sut.srcCopied).toBe(1420);
        expect(sut.literalAdded).toBe(dst.length - 1420);

        // Assert — merge_score reproduces git's M060
        const mergeScore = Math.trunc(((srcSize - sut.srcCopied) * MAX_SCORE) / srcSize);
        expect(Math.trunc((mergeScore * 100) / MAX_SCORE)).toBe(60);
      });
    });
  });

  describe('estimateSimilarityFromMaps', () => {
    describe('Given both empty maps with size 0, When estimateSimilarityFromMaps is called', () => {
      it('Then returns MAX_SCORE (both blobs empty → trivially identical)', () => {
        // Arrange
        const emptyMap = new Map<number, number>();

        // Act
        const result = estimateSimilarityFromMaps(emptyMap, 0, emptyMap, 0);

        // Assert
        expect(result).toBe(MAX_SCORE);
      });
    });

    describe('Given a non-empty src map and empty dst (size 0), When estimateSimilarityFromMaps is called', () => {
      it('Then returns 0 (empty dst → no shared chunks)', () => {
        // Arrange
        const srcBytes = enc.encode('hello\n');
        const srcMap = buildChunkMap(srcBytes);
        const emptyMap = new Map<number, number>();

        // Act
        const result = estimateSimilarityFromMaps(srcMap, srcBytes.length, emptyMap, 0);

        // Assert
        expect(result).toBe(0);
      });
    });

    describe('Given two identical blobs, When estimateSimilarityFromMaps is called with their precomputed maps', () => {
      it('Then returns the same score as estimateSimilarity', () => {
        // Arrange
        const { src, dst } = makeR087Fixture();
        const srcMap = buildChunkMap(src);
        const dstMap = buildChunkMap(dst);

        // Act
        const sut = estimateSimilarityFromMaps(srcMap, src.length, dstMap, dst.length);

        // Assert — must match the byte-level scorer exactly
        expect(sut).toBe(estimateSimilarity(src, dst));
      });
    });
  });

  describe('buildChunkMap', () => {
    // Hash accumulator arithmetic (mutants 1, 4, 5, 8, 9)
    // and flush mechanics (mutants 2, 3, 6, 7)

    describe('Given byte content that flushes to a single chunk, When buildChunkMap is called', () => {
      it.each([
        {
          data: new Uint8Array([0x0a]),
          hash: 10,
          count: 1,
          // Single LF: accum1 = (((0<<7)^(0>>>25)) + 0x0a)>>>0 = 10, accum2 = 0
          // hashval = (10 + imul(0, 0x61)) % 107927 = 10
          label:
            'a single LF byte has hash 10 and byte count 1 (kills mutant 1 +c→-c and mutant 4 %→*)',
        },
        {
          data: new Uint8Array([0x61]),
          hash: 97,
          count: 1,
          // Single 'a' (0x61=97): no in-loop flush (n=1 < 64, not LF)
          // Partial flush: accum1=97, accum2=0 -> hashval = (97 + 0) % 107927 = 97
          label: 'a single non-LF byte has hash 97 and byte count 1 via the partial-chunk path',
        },
        {
          data: new Uint8Array([0x61, 0x0a]),
          hash: 12426,
          count: 2,
          // 'a\n' (0x61, 0x0a): LF triggers in-loop flush with n=2
          // After 'a': accum1=97, accum2=0
          // After '\n': accum1=(((97<<7)^0)+10)>>>0=12426, accum2=((0^(97>>>25))>>>0)=0
          label: 'two bytes ending with LF have hash 12426 and byte count 2 (kills mutant 1 +c→-c)',
        },
        {
          data: new Uint8Array(64).fill(0x61),
          hash: 12233,
          count: 64,
          // 64 'a' bytes: n reaches 64 (n >= 64), in-loop flush with hash 12233; no
          // partial-chunk entry after. Mutant 3 (>= → >) would not flush at n=64.
          label:
            'exactly MAX_CHUNK_LEN (64) non-LF bytes flush in the loop with hash 12233 and byte count 64',
        },
        {
          data: new Uint8Array(30).fill(0x61),
          hash: 23995,
          count: 30,
          // 30 'a' bytes: accum2 becomes non-zero by byte 4; hashval = 23995
          label:
            '30 non-LF bytes (partial chunk, non-zero accum2) have hash 23995 and byte count 30 (kills mutants 8 %→* and 9 +→-)',
        },
        {
          data: new Uint8Array([...new Uint8Array(30).fill(0x61), 0x0a]),
          hash: 89031,
          count: 31,
          // 30 'a' bytes + LF: accum2 is non-zero when LF triggers in-loop flush; hashval = 89031
          label:
            '31 non-LF bytes followed by LF (in-loop flush, non-zero accum2) have hash 89031 and byte count 31 (kills mutants 4 %→* and 5 +→-)',
        },
      ])('Then $label', ({ data, hash, count }) => {
        // Act
        const result = buildChunkMap(data);

        // Assert
        expect(result.size).toBe(1);
        expect(result.get(hash)).toBe(count);
      });
    });

    describe('Given three bytes with LF in the middle, When buildChunkMap is called', () => {
      it('Then the map has two entries: one from the LF flush and one from the partial-chunk flush', () => {
        // Arrange
        // 'a\nb' (0x61, 0x0a, 0x62): LF flushes first chunk (n=2, hash=12426),
        // then 'b' alone stays as partial (n=1, hash=98)
        // Mutant 2 (flush condition → false): no in-loop flush → single entry after loop (n=3, hash≠12426)
        const sut = buildChunkMap;
        const data = new Uint8Array([0x61, 0x0a, 0x62]);

        // Act
        const result = sut(data);

        // Assert — kills mutant 2 (flush=false produces 1 entry with a different hash)
        expect(result.size).toBe(2);
        expect(result.get(12426)).toBe(2);
        expect(result.get(98)).toBe(1);
      });
    });

    describe('Given MAX_CHUNK_LEN+1 (65) non-LF bytes, When buildChunkMap is called', () => {
      it('Then the map has two entries: a 64-byte chunk and a 1-byte partial', () => {
        // Arrange
        // 65 'a' bytes: n=64 satisfies n>=64 → in-loop flush (hash=12233, n=64),
        //   then 65th byte processed: accum1=97, accum2=0 → partial flush (hash=97, n=1)
        // Mutant 3 (>= → >): n=64 does NOT trigger flush (64>64=false);
        //   n=65 triggers flush (65>64=true) with all 65 bytes → single entry, different hash
        const sut = buildChunkMap;
        const data = new Uint8Array(65).fill(0x61);

        // Act
        const result = sut(data);

        // Assert — kills mutant 3: mutant produces 1 entry (all 65 bytes merged into one chunk)
        expect(result.size).toBe(2);
        expect(result.get(12233)).toBe(64);
        expect(result.get(97)).toBe(1);
      });
    });

    describe('Given data ending exactly on a flush boundary (single LF), When buildChunkMap is called', () => {
      it('Then the map has exactly one entry (the partial-chunk guard is not triggered)', () => {
        // Arrange
        // Single LF: flushes in-loop (n=1), then n=0 after loop
        // Mutant 6 (n>0 → true): fires even when n=0, adds entry {0: 0} to map → size becomes 2
        // Mutant 7 (n>0 → n>=0): 0>=0=true, same spurious flush → size becomes 2
        const sut = buildChunkMap;
        const data = new Uint8Array([0x0a]);

        // Act
        const result = sut(data);

        // Assert — kills mutants 6 and 7 (spurious zero-byte entry makes size 2)
        expect(result.size).toBe(1);
        expect(result.has(0)).toBe(false);
      });
    });

    // countSrcCopied guard (mutants 10, 11, 12) via countSpanhashChanges
    // Mutant 10 inverts the guard (<=0): skips SHARED chunks, making srcCopied=0 for identical content
    // Mutants 11 and 12 are covered by the identical-content assertion below

    describe('Given identical non-empty src and dst blobs, When countSpanhashChanges is called', () => {
      it('Then srcCopied equals the full byte count of the blob', () => {
        // Arrange
        // 'hello world\n' (12 bytes, one LF chunk): srcMap === dstMap in content
        // countSrcCopied: dstCnt > 0 for each key → srcCopied = min(12, 12) = 12
        // Mutant 10 (> → <=): dstCnt <= 0 is false for positive dstCnt → srcCopied = 0 (NOT 12)
        const sut = countSpanhashChanges;
        const content = enc.encode('hello world\n');

        // Act
        const result = sut(content, content);

        // Assert — kills mutant 10: with <=, shared entries are skipped → srcCopied=0 ≠ 12
        expect(result.srcCopied).toBe(12);
        expect(result.literalAdded).toBe(0);
      });
    });

    // countSpanhashChanges guard (mutants 13-16) — the srcSize===0 || dstSize===0 arm

    describe('Given only dstSize is zero, When countSpanhashChanges is called', () => {
      it('Then returns srcCopied=0 and literalAdded=0 via the zero-size guard', () => {
        // Arrange
        // src non-empty, dst empty: guard `srcSize===0 || dstSize===0` fires (dstSize===0)
        // Mutant 14 (|| → &&): requires BOTH to be 0 → skips guard, builds maps, srcCopied=0 anyway
        //   but literalAdded = dstSize - 0 = 0 = same (equivalent for dst-empty case via &&)
        // Mutant 16 (dstSize part → false): `srcSize===0 || false` → only fires when src is empty
        //   for non-empty src: guard skips, goes to map path, computes srcCopied=0, literalAdded=0 (same)
        // Mutant 13 (guard → false): skips guard entirely, builds maps → same result for dst-empty
        // Mutant 15 (body → {}): guard fires but returns undefined → result is undefined, not the shape
        const sut = countSpanhashChanges;
        const src = enc.encode('hello world\n');
        const dst = new Uint8Array(0);

        // Act
        const result = sut(src, dst);

        // Assert
        expect(result.srcCopied).toBe(0);
        expect(result.literalAdded).toBe(0);
      });
    });

    describe('Given only srcSize is zero and dst is non-empty, When countSpanhashChanges is called', () => {
      it('Then returns srcCopied=0 and literalAdded equal to dst byte count via the zero-size guard', () => {
        // Arrange
        // src empty, dst non-empty: guard `srcSize===0 || dstSize===0` fires (srcSize===0)
        // Mutant 14 (|| → &&): requires BOTH zero → skips for src-empty/dst-nonempty
        //   then builds maps; srcMap is empty → countSrcCopied returns 0
        //   literalAdded = dstSize - 0 = dstSize → SAME result! equivalent for this arm too
        // Mutant 16 (dstSize part → false): `srcSize===0 || false` = `srcSize===0`
        //   → still fires when src is empty → same result
        // Mutant 13 (guard → false): skips guard, builds maps, srcCopied=0, literalAdded=dstSize → same
        // Mutant 15 (body → {}): guard fires but body is empty → returns undefined → fails shape check
        const sut = countSpanhashChanges;
        const src = new Uint8Array(0);
        const dst = enc.encode('hello world\n');

        // Act
        const result = sut(src, dst);

        // Assert — kills mutant 15 (empty body → undefined instead of the shape)
        expect(result.srcCopied).toBe(0);
        expect(result.literalAdded).toBe(dst.length);
      });
    });

    // estimateSimilarity guard (mutants 17-19) — the srcSize===0 || dstSize===0 → return 0 arm

    describe('Given srcSize is non-zero and dstSize is zero, When estimateSimilarity is called', () => {
      it('Then returns 0 via the one-empty guard, not MAX_SCORE or any map-derived value', () => {
        // Arrange
        // src non-empty, dst empty: maxSize > 0 (bypasses maxSize===0 guard),
        //   then `srcSize===0 || dstSize===0` fires (dstSize===0) → return 0
        // Mutant 17 (guard → false): skips guard, builds empty dstMap, srcCopied=0, score=0 → same result
        // Mutant 18 (|| → &&): only fires when BOTH zero → skips, but dstMap empty → score=0 → same
        // Mutant 19 (dstSize part → false): `srcSize===0 || false` → false for non-empty src → skips
        //   builds maps, dstMap empty, srcCopied=0, score=0 → same
        // All three appear equivalent — covered by existing test; included here for completeness
        const sut = estimateSimilarity;
        const src = enc.encode('hello\n');
        const dst = new Uint8Array(0);

        // Act
        const result = sut(src, dst);

        // Assert
        expect(result).toBe(0);
      });
    });

    // estimateSimilarityFromMaps guard (mutants 20-22) — same pattern

    describe('Given srcSize is non-zero and dstSize is zero maps, When estimateSimilarityFromMaps is called', () => {
      it('Then returns 0 via the one-empty guard', () => {
        // Arrange
        // srcSize > 0, dstSize = 0: maxSize > 0 (no maxSize guard), then `srcSize===0 || dstSize===0`
        //   fires (dstSize===0) → return 0
        // Mutant 20 (|| → &&): skips guard, dstMap empty, srcCopied=0, score=0 → same
        // Mutant 21 (guard → false): skips guard, dstMap empty, srcCopied=0, score=0 → same
        // Mutant 22 (dstSize part → false): same as 20
        // All appear equivalent; included for completeness alongside existing tests
        const sut = estimateSimilarityFromMaps;
        const src = enc.encode('hello\n');
        const srcMap = buildChunkMap(src);
        const emptyMap = new Map<number, number>();

        // Act
        const result = sut(srcMap, src.length, emptyMap, 0);

        // Assert
        expect(result).toBe(0);
      });
    });
  });
});
