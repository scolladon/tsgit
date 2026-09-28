import { describe, expect, it } from 'vitest';
import { BINARY_DETECTION_BYTES } from '../../../../src/domain/diff/line-diff.js';
import {
  buildFingerprint,
  contentKindOf,
  countSpanhashChangesFromFingerprints,
  DEFAULT_BREAK_SCORE,
  DEFAULT_MERGE_SCORE,
  DEFAULT_RENAME_THRESHOLD,
  denseFingerprint,
  estimateSimilarity,
  estimateSimilarityFromFingerprints,
  MAX_SCORE,
  packFingerprint,
  toSimilarityPercent,
} from '../../../../src/domain/diff/similarity.js';

const enc = new TextEncoder();

/** Mirrors git's `HASHBASE` (`diffcore-delta.c`) — the pack/dense dispatch
 *  threshold in `buildFingerprint`. */
const HASHBASE = 107927;

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

/**
 * 8 CRLF-terminated lines, line 2 (0-indexed) changed — no NUL byte, so
 * `contentKindOf` always sniffs 'text'. Stripping the CR of each CRLF pair
 * (text mode) vs hashing it (binary mode) lands on a DIFFERENT srcCopied,
 * pinned by hand against `buildFingerprint(..., kind)` directly.
 */
function makeCrlfPair(): { readonly src: Uint8Array; readonly dst: Uint8Array } {
  const build = (changed: number): Uint8Array => {
    const lines = Array.from({ length: 8 }, (_, i) =>
      i === changed ? `CHANGED line ${i}: xyz` : `original line ${i}: filler content`,
    );
    return enc.encode(`${lines.join('\r\n')}\r\n`);
  };
  return { src: build(-1), dst: build(2) };
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
      { value: MAX_SCORE, expected: 60000, label: 'MAX_SCORE equals 60000' },
      {
        value: DEFAULT_RENAME_THRESHOLD,
        expected: 30000,
        label: 'DEFAULT_RENAME_THRESHOLD equals 30000 (50% of MAX_SCORE)',
      },
      {
        value: DEFAULT_BREAK_SCORE,
        expected: 30000,
        label: 'DEFAULT_BREAK_SCORE equals 30000 (50% of MAX_SCORE)',
      },
      {
        value: DEFAULT_MERGE_SCORE,
        expected: 36000,
        label: 'DEFAULT_MERGE_SCORE equals 36000 (60% of MAX_SCORE)',
      },
    ])('Then $label', ({ value, expected }) => {
      // Arrange + Act + Assert
      expect(value).toBe(expected);
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
        // Arrange + Act
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
        // Arrange + Act
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

  describe('countSpanhashChangesFromFingerprints', () => {
    describe('Given src and dst byte content, When countSpanhashChangesFromFingerprints is called', () => {
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
        // Arrange + Act
        const result = countSpanhashChangesFromFingerprints(
          buildFingerprint(src, contentKindOf(src)),
          buildFingerprint(dst, contentKindOf(dst)),
        );

        // Assert
        expect(result.srcCopied).toBe(srcCopied);
        expect(result.literalAdded).toBe(literalAdded);
      });
    });

    describe('Given the pinned B2 fixture (total=20 lines, shared=7), When countSpanhashChangesFromFingerprints is called', () => {
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
        const result = countSpanhashChangesFromFingerprints(
          buildFingerprint(src, contentKindOf(src)),
          buildFingerprint(dst, contentKindOf(dst)),
        );

        // Assert — exact srcCopied to kill arithmetic mutants
        expect(result.srcCopied).toBe(497);
        expect(result.literalAdded).toBe(dst.length - 497);

        // Assert — merge_score reproduces git's M065
        const mergeScore = Math.trunc(((srcSize - result.srcCopied) * MAX_SCORE) / srcSize);
        expect(Math.trunc((mergeScore * 100) / MAX_SCORE)).toBe(65);
      });
    });

    describe('Given the pinned B5 fixture (total=50 lines, shared=20), When countSpanhashChangesFromFingerprints is called', () => {
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
        const result = countSpanhashChangesFromFingerprints(
          buildFingerprint(src, contentKindOf(src)),
          buildFingerprint(dst, contentKindOf(dst)),
        );

        // Assert — exact srcCopied to kill arithmetic mutants
        expect(result.srcCopied).toBe(1420);
        expect(result.literalAdded).toBe(dst.length - 1420);

        // Assert — merge_score reproduces git's M060
        const mergeScore = Math.trunc(((srcSize - result.srcCopied) * MAX_SCORE) / srcSize);
        expect(Math.trunc((mergeScore * 100) / MAX_SCORE)).toBe(60);
      });
    });

    describe('Given a CRLF-bearing pair with no override, When countSpanhashChangesFromFingerprints is called', () => {
      it('Then literalAdded excludes the skipped CR bytes from dst (CR of CRLF skipped)', () => {
        // Arrange — 8 CRLF-terminated lines, line 2 changed; no NUL so the
        // sniff picks 'text', which skips the CR of every CRLF pair — dst's
        // fingerprint therefore covers 8 fewer bytes than dst.length.
        const { src, dst } = makeCrlfPair();
        const dstCrBytesSkipped = 8;

        // Act
        const result = countSpanhashChangesFromFingerprints(
          buildFingerprint(src, contentKindOf(src)),
          buildFingerprint(dst, contentKindOf(dst)),
        );

        // Assert — pinned by hand against buildFingerprint(..., 'text')
        expect(result.srcCopied).toBe(224);
        expect(result.literalAdded).toBe(dst.length - dstCrBytesSkipped - 224);
      });
    });

    describe('Given a CRLF-bearing pair with an explicit text override, When countSpanhashChangesFromFingerprints is called', () => {
      it('Then literalAdded matches the no-override sniff (both land on text)', () => {
        // Arrange
        const { src, dst } = makeCrlfPair();
        const dstCrBytesSkipped = 8;

        // Act
        const result = countSpanhashChangesFromFingerprints(
          buildFingerprint(src, 'text'),
          buildFingerprint(dst, 'text'),
        );

        // Assert
        expect(result.srcCopied).toBe(224);
        expect(result.literalAdded).toBe(dst.length - dstCrBytesSkipped - 224);
      });
    });

    describe('Given a CRLF-bearing pair with an explicit binary override, When countSpanhashChangesFromFingerprints is called', () => {
      it('Then srcCopied differs from the sniff (CR bytes are hashed, not skipped)', () => {
        // Arrange
        const { src, dst } = makeCrlfPair();

        // Act
        const result = countSpanhashChangesFromFingerprints(
          buildFingerprint(src, 'binary'),
          buildFingerprint(dst, 'binary'),
        );

        // Assert — pinned by hand against buildFingerprint(..., 'binary')
        expect(result.srcCopied).toBe(231);
        expect(result.literalAdded).toBe(dst.length - 231);
      });
    });
  });

  describe('estimateSimilarityFromFingerprints', () => {
    describe('Given both empty fingerprints with size 0, When estimateSimilarityFromFingerprints is called', () => {
      it('Then returns MAX_SCORE (both blobs empty → trivially identical)', () => {
        // Arrange
        const empty = buildFingerprint(new Uint8Array(0), 'text');

        // Act
        const result = estimateSimilarityFromFingerprints(empty, 0, empty, 0);

        // Assert
        expect(result).toBe(MAX_SCORE);
      });
    });

    describe('Given a non-empty src fingerprint and empty dst (size 0), When estimateSimilarityFromFingerprints is called', () => {
      it('Then returns 0 (empty dst → no shared chunks)', () => {
        // Arrange
        const srcBytes = enc.encode('hello\n');
        const srcFingerprint = buildFingerprint(srcBytes, 'text');
        const empty = buildFingerprint(new Uint8Array(0), 'text');

        // Act
        const result = estimateSimilarityFromFingerprints(
          srcFingerprint,
          srcBytes.length,
          empty,
          0,
        );

        // Assert
        expect(result).toBe(0);
      });
    });

    describe('Given two identical blobs, When estimateSimilarityFromFingerprints is called with their precomputed fingerprints', () => {
      it('Then returns the same score as estimateSimilarity', () => {
        // Arrange
        const { src, dst } = makeR087Fixture();
        const srcFingerprint = buildFingerprint(src, 'text');
        const dstFingerprint = buildFingerprint(dst, 'text');

        // Act
        const result = estimateSimilarityFromFingerprints(
          srcFingerprint,
          src.length,
          dstFingerprint,
          dst.length,
        );

        // Assert — must match the byte-level scorer exactly
        expect(result).toBe(estimateSimilarity(src, dst));
      });
    });
  });

  describe('packFingerprint', () => {
    describe('Given byte content that flushes to a single chunk, When packFingerprint is called', () => {
      it.each([
        {
          data: new Uint8Array([0x0a]),
          hash: 10,
          count: 1,
          // Single LF: accum1 = (((0<<7)^(0>>>25)) + 0x0a)>>>0 = 10, accum2 = 0
          // hashval = (10 + imul(0, 0x61)) % 107927 = 10
          label: 'a single LF byte has hash 10 and byte count 1',
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
          label: 'two bytes ending with LF have hash 12426 and byte count 2',
        },
        {
          data: new Uint8Array(64).fill(0x61),
          hash: 12233,
          count: 64,
          // 64 'a' bytes: n reaches 64 (n >= 64), in-loop flush with hash 12233; no
          // partial-chunk entry after.
          label:
            'exactly MAX_CHUNK_LEN (64) non-LF bytes flush in the loop with hash 12233 and byte count 64',
        },
        {
          data: new Uint8Array(30).fill(0x61),
          hash: 23995,
          count: 30,
          // 30 'a' bytes: accum2 becomes non-zero by byte 4; hashval = 23995
          label:
            '30 non-LF bytes (partial chunk, non-zero accum2) have hash 23995 and byte count 30',
        },
        {
          data: new Uint8Array([...new Uint8Array(30).fill(0x61), 0x0a]),
          hash: 89031,
          count: 31,
          // 30 'a' bytes + LF: accum2 is non-zero when LF triggers in-loop flush; hashval = 89031
          label:
            '31 non-LF bytes followed by LF (in-loop flush, non-zero accum2) have hash 89031 and byte count 31',
        },
      ])('Then $label', ({ data, hash, count }) => {
        // Arrange + Act
        const result = packFingerprint(data, 'text');

        // Assert
        expect(Array.from(result.hashes)).toEqual([hash]);
        expect(Array.from(result.counts)).toEqual([count]);
      });
    });

    describe('Given three bytes with LF in the middle, When packFingerprint is called', () => {
      it('Then the fingerprint has two entries, ascending by hash: the partial-chunk flush then the LF flush', () => {
        // Arrange
        // 'a\nb' (0x61, 0x0a, 0x62): LF flushes first chunk (n=2, hash=12426),
        // then 'b' alone stays as partial (n=1, hash=98) — ascending order puts 98 first.
        const data = new Uint8Array([0x61, 0x0a, 0x62]);

        // Act
        const result = packFingerprint(data, 'text');

        // Assert
        expect(Array.from(result.hashes)).toEqual([98, 12426]);
        expect(Array.from(result.counts)).toEqual([1, 2]);
      });
    });

    describe('Given MAX_CHUNK_LEN+1 (65) non-LF bytes, When packFingerprint is called', () => {
      it('Then the fingerprint has two entries: a 1-byte partial and a 64-byte chunk', () => {
        // Arrange
        // 65 'a' bytes: n=64 satisfies n>=64 → in-loop flush (hash=12233, n=64),
        //   then 65th byte processed: accum1=97, accum2=0 → partial flush (hash=97, n=1)
        const data = new Uint8Array(65).fill(0x61);

        // Act
        const result = packFingerprint(data, 'text');

        // Assert
        expect(Array.from(result.hashes)).toEqual([97, 12233]);
        expect(Array.from(result.counts)).toEqual([1, 64]);
      });
    });

    describe('Given data ending exactly on a flush boundary (single LF), When packFingerprint is called', () => {
      it('Then the fingerprint has exactly one entry (the trailing partial-chunk flush is not triggered)', () => {
        // Arrange — single LF: flushes in-loop (n=1), then n=0 after loop, so no
        // spurious zero-byte entry should ever be produced.
        const data = new Uint8Array([0x0a]);

        // Act
        const result = packFingerprint(data, 'text');

        // Assert
        expect(Array.from(result.hashes)).toEqual([10]);
        expect(Array.from(result.counts)).toEqual([1]);
      });
    });

    describe('Given a 6-byte chunk whose accumulator sum overflows 2^32, When packFingerprint is called', () => {
      it('Then the bucket wraps to uint32 before the modulo, matching git unsigned-int arithmetic', () => {
        // Arrange — found by search: after these 6 bytes (no LF, single partial-chunk
        // flush), accum1=4294913788 and accum2=757. Math.imul(757, 0x61) = 73429, and
        // accum1 + 73429 = 4294987217, which is 2^32 + 19921 — it overflows uint32.
        // git's `unsigned int` sum wraps mod 2^32 BEFORE `% HASHBASE`: 19921 % 107927 = 19921.
        // Without the `>>> 0` wrap, `(accum1 + 73429) % 107927` uses the un-wrapped double
        // and lands on a different bucket (32252).
        const data = new Uint8Array([94, 95, 127, 124, 92, 252]);

        // Act
        const result = packFingerprint(data, 'text');

        // Assert
        expect(Array.from(result.hashes)).toEqual([19921]);
        expect(Array.from(result.counts)).toEqual([6]);
      });
    });

    describe('Given a CR immediately followed by an LF, When packFingerprint is called with kind "text"', () => {
      it('Then the CR is skipped: neither accumulated nor counted', () => {
        // Arrange — 'A\r\n': the CR is skipped (kind is text and the next byte is LF),
        // so only 'A' and the LF accumulate into one 2-byte chunk.
        // accum1 after 'A' (0x41=65): 65, accum2: 0.
        // accum1 after LF (0x0a=10): (((65<<7)^(0>>>25))+10)>>>0 = 8330, accum2: 0.
        // bucketOf(8330, 0) = 8330 % 107927 = 8330.
        const data = new Uint8Array([0x41, 0x0d, 0x0a]);

        // Act
        const result = packFingerprint(data, 'text');

        // Assert — hashing the CR anyway would produce hash 95291 with count 3
        // instead of 8330 with count 2.
        expect(Array.from(result.hashes)).toEqual([8330]);
        expect(Array.from(result.counts)).toEqual([2]);
      });
    });

    describe('Given a lone CR not followed by an LF, When packFingerprint is called with kind "text"', () => {
      it('Then the CR is hashed like any other byte', () => {
        // Arrange — '\rA': the CR is NOT followed by LF, so the skip guard never
        // fires; both bytes accumulate into one 2-byte partial chunk.
        // accum1 after CR (0x0d=13): 13, accum2: 0.
        // accum1 after 'A' (0x41=65): (((13<<7)^(0>>>25))+65)>>>0 = 1729, accum2: 0.
        // bucketOf(1729, 0) = 1729 % 107927 = 1729.
        const data = new Uint8Array([0x0d, 0x41]);

        // Act
        const result = packFingerprint(data, 'text');

        // Assert
        expect(Array.from(result.hashes)).toEqual([1729]);
        expect(Array.from(result.counts)).toEqual([2]);
      });
    });

    describe('Given a trailing CR with no following byte, When packFingerprint is called with kind "text"', () => {
      it('Then the CR is hashed: the skip guard needs a following LF byte', () => {
        // Arrange — 'A\r': the CR is the LAST byte, so `i + 1 < size` is false and
        // the skip guard never fires; both bytes accumulate into one 2-byte chunk.
        // accum1 after 'A' (0x41=65): 65, accum2: 0.
        // accum1 after CR (0x0d=13): (((65<<7)^(0>>>25))+13)>>>0 = 8333, accum2: 0.
        // bucketOf(8333, 0) = 8333 % 107927 = 8333.
        const data = new Uint8Array([0x41, 0x0d]);

        // Act
        const result = packFingerprint(data, 'text');

        // Assert
        expect(Array.from(result.hashes)).toEqual([8333]);
        expect(Array.from(result.counts)).toEqual([2]);
      });
    });

    describe('Given a CR immediately followed by an LF, When packFingerprint is called with kind "binary"', () => {
      it('Then the CR is hashed: the skip guard only fires for text', () => {
        // Arrange — same 'A\r\n' bytes as the text case above, but kind is binary
        // so the CR is never skipped: all 3 bytes accumulate into one chunk.
        const data = new Uint8Array([0x41, 0x0d, 0x0a]);

        // Act
        const result = packFingerprint(data, 'binary');

        // Assert
        expect(Array.from(result.hashes)).toEqual([95291]);
        expect(Array.from(result.counts)).toEqual([3]);
      });
    });
  });

  describe('denseFingerprint', () => {
    describe('Given a trailing (unflushed) chunk whose bucket was already touched by an earlier forced-flush chunk, When denseFingerprint is called', () => {
      it('Then the trailing chunk folds into the SAME bucket entry instead of touching it as new', () => {
        // Arrange — a 64-byte forced-flush chunk (no LF, hits MAX_CHUNK_LEN)
        // and a 33-byte trailing leftover chunk (no LF, ends the buffer before
        // reaching MAX_CHUNK_LEN) whose spanhash buckets collide by
        // construction (found by search, verified against the algorithm):
        // both land on bucket 78351. This exercises the trailing flush's OWN
        // `accum[bucket] === 0` check taking its FALSE branch — the earlier
        // chunk already marked the bucket touched — which no LF-terminated
        // pair of chunks (different lengths by construction) can reach.
        const earlier = [
          100, 54, 124, 40, 90, 57, 112, 87, 105, 87, 90, 41, 90, 43, 109, 91, 99, 44, 77, 62, 46,
          94, 44, 111, 78, 85, 113, 53, 126, 120, 94, 34, 44, 115, 33, 122, 125, 68, 47, 113, 34,
          105, 97, 61, 109, 55, 77, 78, 65, 66, 48, 107, 106, 84, 80, 41, 41, 71, 63, 42, 110, 62,
          59, 124,
        ];
        const leftover = [
          32, 48, 39, 91, 86, 110, 77, 87, 71, 117, 98, 68, 125, 50, 102, 89, 51, 76, 123, 100, 59,
          70, 98, 104, 74, 93, 68, 71, 73, 90, 74, 102, 115,
        ];
        const data = Uint8Array.from([...earlier, ...leftover]);
        const sut = denseFingerprint;

        // Act
        const result = sut(data, 'text');

        // Assert — one bucket carries both chunks' combined byte count.
        expect(Array.from(result.hashes)).toEqual([78351]);
        expect(Array.from(result.counts)).toEqual([earlier.length + leftover.length]);
      });
    });
  });

  describe('buildFingerprint', () => {
    describe('Given content one byte below the pack/dense size threshold, When buildFingerprint is called', () => {
      it('Then it matches the packed builder', () => {
        // Arrange
        const data = new Uint8Array(HASHBASE - 1).fill(0x61);

        // Act
        const result = buildFingerprint(data, 'text');

        // Assert
        expect(result).toEqual(packFingerprint(data, 'text'));
      });
    });

    describe('Given content at the pack/dense size threshold, When buildFingerprint is called', () => {
      it('Then it matches the dense builder', () => {
        // Arrange
        const data = new Uint8Array(HASHBASE).fill(0x61);

        // Act
        const result = buildFingerprint(data, 'text');

        // Assert
        expect(result).toEqual(denseFingerprint(data, 'text'));
      });
    });
  });

  describe('countSpanhashChangesFromFingerprints guards', () => {
    describe('Given identical non-empty src and dst blobs, When countSpanhashChangesFromFingerprints is called', () => {
      it('Then srcCopied equals the full byte count of the blob', () => {
        // Arrange — 'hello world\n' (12 bytes, one LF chunk): src and dst share
        // every chunk hash, so every byte counts as copied.
        const content = enc.encode('hello world\n');

        // Act
        const result = countSpanhashChangesFromFingerprints(
          buildFingerprint(content, contentKindOf(content)),
          buildFingerprint(content, contentKindOf(content)),
        );

        // Assert
        expect(result.srcCopied).toBe(12);
        expect(result.literalAdded).toBe(0);
      });
    });

    describe('Given only dstSize is zero, When countSpanhashChangesFromFingerprints is called', () => {
      it('Then returns srcCopied=0 and literalAdded=0 via the zero-size guard', () => {
        // Arrange
        const src = enc.encode('hello world\n');
        const dst = new Uint8Array(0);

        // Act
        const result = countSpanhashChangesFromFingerprints(
          buildFingerprint(src, contentKindOf(src)),
          buildFingerprint(dst, contentKindOf(dst)),
        );

        // Assert
        expect(result.srcCopied).toBe(0);
        expect(result.literalAdded).toBe(0);
      });
    });

    describe('Given only srcSize is zero and dst is non-empty, When countSpanhashChangesFromFingerprints is called', () => {
      it('Then returns srcCopied=0 and literalAdded equal to dst byte count via the zero-size guard', () => {
        // Arrange
        const src = new Uint8Array(0);
        const dst = enc.encode('hello world\n');

        // Act
        const result = countSpanhashChangesFromFingerprints(
          buildFingerprint(src, contentKindOf(src)),
          buildFingerprint(dst, contentKindOf(dst)),
        );

        // Assert
        expect(result.srcCopied).toBe(0);
        expect(result.literalAdded).toBe(dst.length);
      });
    });
  });

  describe('estimateSimilarity and estimateSimilarityFromFingerprints guards', () => {
    describe('Given srcSize is non-zero and dstSize is zero, When estimateSimilarity is called', () => {
      it('Then returns 0 via the one-empty guard, not MAX_SCORE or any fingerprint-derived value', () => {
        // Arrange
        const src = enc.encode('hello\n');
        const dst = new Uint8Array(0);

        // Act
        const result = estimateSimilarity(src, dst);

        // Assert
        expect(result).toBe(0);
      });
    });

    describe('Given srcSize is non-zero and dstSize is zero fingerprints, When estimateSimilarityFromFingerprints is called', () => {
      it('Then returns 0 via the one-empty guard', () => {
        // Arrange
        const src = enc.encode('hello\n');
        const srcFingerprint = buildFingerprint(src, 'text');
        const empty = buildFingerprint(new Uint8Array(0), 'text');

        // Act
        const result = estimateSimilarityFromFingerprints(srcFingerprint, src.length, empty, 0);

        // Assert
        expect(result).toBe(0);
      });
    });
  });

  describe('contentKindOf', () => {
    describe('Given bytes with no NUL in the first 8000 bytes, When contentKindOf is called', () => {
      it('Then returns "text"', () => {
        // Arrange + Act
        const result = contentKindOf(enc.encode('hello world\n'));

        // Assert
        expect(result).toBe('text');
      });
    });

    describe('Given bytes with a NUL in the first 8000 bytes, When contentKindOf is called', () => {
      it('Then returns "binary"', () => {
        // Arrange
        const bytes = new Uint8Array(16).fill(0x61);
        bytes[4] = 0x00;

        // Act
        const result = contentKindOf(bytes);

        // Assert
        expect(result).toBe('binary');
      });
    });

    describe('Given a NUL at the last byte inside the detection window, When contentKindOf is called', () => {
      it('Then returns "binary"', () => {
        // Arrange — NUL at index BINARY_DETECTION_BYTES - 1 is inside the window
        const bytes = new Uint8Array(BINARY_DETECTION_BYTES + 1).fill(0x61);
        bytes[BINARY_DETECTION_BYTES - 1] = 0x00;

        // Act
        const result = contentKindOf(bytes);

        // Assert
        expect(result).toBe('binary');
      });
    });

    describe('Given a NUL at the first byte outside the detection window, When contentKindOf is called', () => {
      it('Then returns "text" — the window boundary is exclusive', () => {
        // Arrange — NUL at index BINARY_DETECTION_BYTES is outside the window
        const bytes = new Uint8Array(BINARY_DETECTION_BYTES + 1).fill(0x61);
        bytes[BINARY_DETECTION_BYTES] = 0x00;

        // Act
        const result = contentKindOf(bytes);

        // Assert
        expect(result).toBe('text');
      });
    });
  });

  describe('Given a CRLF pair only on the src side, When countSpanhashChangesFromFingerprints is called', () => {
    it('Then the CR in src is skipped, matching a dst that never had it (srcCopied equals dstSize)', () => {
      // Arrange — src = 'A\r\nB\n' (5 bytes), dst = 'A\nB\n' (4 bytes). Both sides are
      // text (no NUL), so src's CR is skipped: its two chunks (hash(A,LF)=8330 and
      // hash(B,LF)) become byte-for-byte the same chunks dst hashes, so every byte
      // of dst is copied from src. Without the fix, src's first chunk would hash
      // to 95291 (CR included) instead of 8330, so only the second chunk (2 bytes)
      // would be shared and literalAdded would be 2, not 0.
      const src = enc.encode('A\r\nB\n');
      const dst = enc.encode('A\nB\n');

      // Act
      const result = countSpanhashChangesFromFingerprints(
        buildFingerprint(src, contentKindOf(src)),
        buildFingerprint(dst, contentKindOf(dst)),
      );

      // Assert
      expect(result.srcCopied).toBe(4);
      expect(result.literalAdded).toBe(0);
    });
  });

  describe('Given a CRLF pair only on the src side, When estimateSimilarity is called', () => {
    it('Then the score reflects the CR-skipped byte count, not the CR-counted one', () => {
      // Arrange — same pair as above: fixed srcCopied=4, maxSize=5 → trunc(4*60000/5)=48000.
      // Without the fix (CR counted), srcCopied would be 2 → trunc(2*60000/5)=24000.
      const src = enc.encode('A\r\nB\n');
      const dst = enc.encode('A\nB\n');

      // Act
      const result = estimateSimilarity(src, dst);

      // Assert
      expect(result).toBe(48000);
    });
  });
});
