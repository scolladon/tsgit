import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildGrepMatcher,
  type GrepPattern,
  type MatchSpan,
} from '../../../../src/domain/grep/matcher.js';

// ---------------------------------------------------------------------------
// Helpers / independent oracles (must NOT re-implement regexp.exec)
// ---------------------------------------------------------------------------

/** Hand-rolled byte-level indexOf — the independent oracle for fixed-mode. */
function bytesIndexOf(haystack: Uint8Array, needle: Uint8Array, fromIndex = 0): number {
  if (needle.length === 0) return fromIndex;
  outer: for (let i = fromIndex; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Collect all non-overlapping byte spans of needle in haystack via oracle. */
function allBytesIndexes(haystack: Uint8Array, needle: Uint8Array): ReadonlyArray<MatchSpan> {
  if (needle.length === 0) return [];
  const spans: MatchSpan[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = bytesIndexOf(haystack, needle, from);
    if (idx < 0) break;
    spans.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length;
  }
  return spans;
}

/** Arbitrary for a non-empty printable ASCII string (used as fixed pattern values). */
const arbAsciiString = fc.string({ minLength: 1, maxLength: 20, unit: 'binary-ascii' });

/** Arbitrary for a Uint8Array of printable ASCII bytes. */
const arbAsciiLine = fc
  .string({ minLength: 0, maxLength: 80, unit: 'binary-ascii' })
  .map((s) => new TextEncoder().encode(s));

// ---------------------------------------------------------------------------
// Property 1 — fixed-mode substring invariant (lens 2, numRuns 200)
// ---------------------------------------------------------------------------

describe('matcher properties', () => {
  describe('Given an arbitrary ASCII line and fixed pattern', () => {
    describe('When matchLine is called with a fixed pattern', () => {
      it('Then returned spans match exactly the oracle bytesIndexOf spans', () => {
        // Arrange
        fc.assert(
          fc.property(arbAsciiLine, arbAsciiString, (line, fixedStr) => {
            const pattern = { fixed: fixedStr };
            const needleBytes = new TextEncoder().encode(fixedStr);
            const sut = buildGrepMatcher([pattern]);

            // Act
            const result = sut.matchLine(line);

            // Assert — oracle is independent bytesIndexOf, NOT regexp.exec
            const expected = allBytesIndexes(line, needleBytes);
            if (expected.length > 0) {
              expect(result.returned).toBe(true);
              expect(result.spans).toEqual(expected);
            } else {
              expect(result.returned).toBe(false);
              expect(result.spans).toHaveLength(0);
            }
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Property 2 — invert is the per-line set-complement (numRuns 100)
  // ---------------------------------------------------------------------------

  describe('Given an arbitrary ASCII line and fixed pattern', () => {
    describe('When invert=true, the verdict is the complement of non-invert', () => {
      it('Then a line is returned under invert iff it has NO span under non-invert', () => {
        // Arrange
        fc.assert(
          fc.property(arbAsciiLine, arbAsciiString, (line, fixedStr) => {
            const pattern = { fixed: fixedStr };
            const nonInvertSut = buildGrepMatcher([pattern], { invert: false });
            const invertSut = buildGrepMatcher([pattern], { invert: true });

            // Act
            const nonInvertResult = nonInvertSut.matchLine(line);
            const invertResult = invertSut.matchLine(line);

            // Assert — set complement: exactly one is true
            expect(invertResult.returned).toBe(!nonInvertResult.returned);
            // inverted verdicts carry empty spans
            if (invertResult.returned) {
              expect(invertResult.spans).toHaveLength(0);
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Property 3 — multi-pattern OR is the union (numRuns 100)
  // ---------------------------------------------------------------------------

  describe('Given two arbitrary fixed patterns and an ASCII line', () => {
    describe('When called with [p, q] vs [p] and [q] separately', () => {
      it('Then OR span set equals union of single-pattern span sets', () => {
        // Arrange
        fc.assert(
          fc.property(arbAsciiLine, arbAsciiString, arbAsciiString, (line, fix1, fix2) => {
            const p: GrepPattern = { fixed: fix1 };
            const q: GrepPattern = { fixed: fix2 };
            const sutBoth = buildGrepMatcher([p, q]);
            const sutP = buildGrepMatcher([p]);
            const sutQ = buildGrepMatcher([q]);

            // Act
            const resultBoth = sutBoth.matchLine(line);
            const resultP = sutP.matchLine(line);
            const resultQ = sutQ.matchLine(line);

            // Assert — union of single-pattern spans (after dedup + sort)
            const unionSet = new Set<string>();
            for (const s of [...resultP.spans, ...resultQ.spans]) {
              unionSet.add(`${s.start}:${s.end}`);
            }
            const unionSpans = [...unionSet]
              .map((k) => {
                const [startStr, endStr] = k.split(':');
                return { start: Number(startStr), end: Number(endStr) };
              })
              .sort((a, b) => a.start - b.start || a.end - b.end);

            expect(resultBoth.spans).toEqual(unionSpans);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Property 4 — wholeWord soundness (numRuns 100)
  // ---------------------------------------------------------------------------

  describe('Given an arbitrary ASCII line and fixed pattern with wholeWord=true', () => {
    describe('When a span survives whole-word gating', () => {
      it('Then both boundaries are non-word bytes or line edges', () => {
        // Arrange
        const WORD_BYTE_RE = /[A-Za-z0-9_]/;

        fc.assert(
          fc.property(arbAsciiLine, arbAsciiString, (line, fixedStr) => {
            const sut = buildGrepMatcher([{ fixed: fixedStr }], { wholeWord: true });

            // Act
            const result = sut.matchLine(line);

            // Assert — every surviving span has non-word boundaries
            for (const span of result.spans) {
              const leftByte = span.start > 0 ? line[span.start - 1] : undefined;
              const rightByte = span.end < line.length ? line[span.end] : undefined;

              if (leftByte !== undefined) {
                const leftChar = String.fromCharCode(leftByte);
                expect(WORD_BYTE_RE.test(leftChar)).toBe(false);
              }
              if (rightByte !== undefined) {
                const rightChar = String.fromCharCode(rightByte);
                expect(WORD_BYTE_RE.test(rightChar)).toBe(false);
              }
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Property 5 — byte-offset round-trip (numRuns 100)
  // ---------------------------------------------------------------------------

  describe('Given an arbitrary ASCII line and fixed pattern', () => {
    describe('When spans are returned', () => {
      it('Then line.slice(start, end) contains the matched pattern bytes', () => {
        // Arrange
        fc.assert(
          fc.property(arbAsciiLine, arbAsciiString, (line, fixedStr) => {
            const needleBytes = new TextEncoder().encode(fixedStr);
            const sut = buildGrepMatcher([{ fixed: fixedStr }]);

            // Act
            const result = sut.matchLine(line);

            // Assert — each span round-trips back to the needle bytes
            for (const span of result.spans) {
              const sliced = line.slice(span.start, span.end);
              expect(sliced).toEqual(needleBytes);
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
