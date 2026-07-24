import { describe, expect, it } from 'vitest';
import { buildGrepMatcher } from '../../../../src/domain/grep/matcher.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('buildGrepMatcher', () => {
  describe('Given a pattern with the u flag', () => {
    describe('When buildGrepMatcher is called', () => {
      it('Then throws INVALID_OPTION with option=pattern', () => {
        // Arrange
        const pattern = /hello/u;

        // Act
        let caught: unknown;
        try {
          buildGrepMatcher([pattern]);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeDefined();
        const err = caught as { data: { code: string; option: string; reason: string } };
        expect(err.data.code).toBe('INVALID_OPTION');
        expect(err.data.option).toBe('pattern');
        expect(err.data.reason).toMatch(/unicode/i);
      });
    });
  });

  describe('Given an empty patterns array', () => {
    describe('When matchLine is called', () => {
      it('Then returns returned=false for any line', () => {
        // Arrange
        const sut = buildGrepMatcher([]);
        const line = enc('hello world');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(false);
      });
    });
  });

  describe('Given a regex pattern /hello/', () => {
    describe('When matchLine is called on a matching line', () => {
      it('Then returns returned=true with correct byte spans', () => {
        // Arrange
        const sut = buildGrepMatcher([/hello/]);
        const line = enc('say hello world');

        // Act
        const result = sut.matchLine(line);

        // Assert
        const span = result.spans[0];
        expect(result.returned).toBe(true);
        expect(result.spans).toHaveLength(1);
        expect(span).toEqual({ start: 4, end: 9 });
        expect(line.slice(span?.start, span?.end)).toEqual(enc('hello'));
      });
    });

    describe('When matchLine is called on a non-matching line', () => {
      it('Then returns returned=false with empty spans', () => {
        // Arrange
        const sut = buildGrepMatcher([/hello/]);
        const line = enc('no match here');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(false);
        expect(result.spans).toHaveLength(0);
      });
    });
  });

  describe('Given a regex pattern with multiple matches on a line', () => {
    describe('When matchLine is called', () => {
      it('Then returns all spans', () => {
        // Arrange
        const sut = buildGrepMatcher([/ab/]);
        const line = enc('ab cd ab ef ab');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(true);
        expect(result.spans).toHaveLength(3);
        expect(result.spans[0]).toEqual({ start: 0, end: 2 });
        expect(result.spans[1]).toEqual({ start: 6, end: 8 });
        expect(result.spans[2]).toEqual({ start: 12, end: 14 });
      });
    });
  });

  describe('Given a non-global caller RegExp with two occurrences on the line', () => {
    describe('When matchLine is called', () => {
      it('Then returns BOTH spans and caller.lastIndex stays 0', () => {
        // Arrange
        const callerRegex = /ab/; // non-global
        const sut = buildGrepMatcher([callerRegex]);
        const line = enc('ab cd ab');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.spans).toHaveLength(2);
        expect(callerRegex.lastIndex).toBe(0);
      });
    });
  });

  describe('Given a regex with sticky y flag', () => {
    describe('When matchLine is called', () => {
      it('Then both spans are found (y flag stripped internally)', () => {
        // Arrange
        const sut = buildGrepMatcher([/ab/y]);
        const line = enc('ab cd ab');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.spans).toHaveLength(2);
      });
    });
  });

  describe('Given a multi-byte UTF-8 line with an ASCII match after the UTF-8 run', () => {
    describe('When matchLine is called', () => {
      it('Then span byte offsets are correct (latin1 bridge)', () => {
        // Arrange
        // "é" in UTF-8 is 0xC3 0xA9 (2 bytes), "x" follows at byte offset 2
        const line = new Uint8Array([0xc3, 0xa9, 0x78]); // é (2 bytes) + x (1 byte)
        const sut = buildGrepMatcher([/x/]);

        // Act
        const result = sut.matchLine(line);

        // Assert
        const span = result.spans[0];
        expect(result.returned).toBe(true);
        expect(result.spans).toHaveLength(1);
        expect(span).toEqual({ start: 2, end: 3 });
        // Round-trip: slicing the raw line at the reported span yields the matched bytes
        expect(line.slice(span?.start, span?.end)).toEqual(new Uint8Array([0x78]));
      });
    });
  });

  describe('Given a fixed pattern { fixed: "a+" }', () => {
    describe('When matchLine is called on a line containing literal "a+"', () => {
      it('Then matches literally (not as regex)', () => {
        // Arrange
        const sut = buildGrepMatcher([{ fixed: 'a+' }]);
        const line = enc('foo a+ bar');

        // Act
        const result = sut.matchLine(line);

        // Assert
        const span = result.spans[0];
        expect(result.returned).toBe(true);
        expect(result.spans).toHaveLength(1);
        expect(line.slice(span?.start, span?.end)).toEqual(enc('a+'));
      });
    });

    describe('When matchLine is called on a line containing "aaa" but not "a+"', () => {
      it('Then does NOT match', () => {
        // Arrange
        const sut = buildGrepMatcher([{ fixed: 'a+' }]);
        const line = enc('aaa');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(false);
      });
    });
  });

  describe('Given a fixed pattern { fixed: "x.y" }', () => {
    describe('When matchLine is called on a line with literal "x.y"', () => {
      it('Then matches literally (dot not metachar)', () => {
        // Arrange
        const sut = buildGrepMatcher([{ fixed: 'x.y' }]);
        const line = enc('test x.y end');

        // Act
        const result = sut.matchLine(line);

        // Assert
        const span = result.spans[0];
        expect(result.returned).toBe(true);
        expect(line.slice(span?.start, span?.end)).toEqual(enc('x.y'));
      });
    });

    describe('When matchLine is called on "xay" (dot not matching any char)', () => {
      it('Then does NOT match', () => {
        // Arrange
        const sut = buildGrepMatcher([{ fixed: 'x.y' }]);
        const line = enc('xay');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(false);
      });
    });
  });

  describe('Given a fixed pattern { fixed: "star*lit" }', () => {
    describe('When matchLine is called', () => {
      it('Then matches literally (star not metachar)', () => {
        // Arrange
        const sut = buildGrepMatcher([{ fixed: 'star*lit' }]);
        const line = enc('test star*lit end');

        // Act
        const result = sut.matchLine(line);

        // Assert
        const span = result.spans[0];
        expect(result.returned).toBe(true);
        expect(line.slice(span?.start, span?.end)).toEqual(enc('star*lit'));
      });
    });
  });

  describe('-w whole-word gating', () => {
    describe('Given wholeWord=true and a regex pattern /hello/', () => {
      describe('When matchLine is called and both boundaries are non-word bytes', () => {
        it('Then matches', () => {
          // Arrange
          const sut = buildGrepMatcher([/hello/], { wholeWord: true });
          const line = enc(' hello world');

          // Act
          const result = sut.matchLine(line);

          // Assert
          expect(result.returned).toBe(true);
          expect(result.spans).toHaveLength(1);
        });
      });

      describe('When matchLine is called at a guard, edge, or match boundary', () => {
        it.each([
          {
            // 'xhello world' — 'x' before 'hello' is a word byte
            line: 'xhello world',
            expected: false,
            label: 'does NOT match when the LEFT boundary is a word byte (left guard triggered)',
          },
          {
            // ' hellox' — 'x' after 'hello' is a word byte
            line: ' hellox world',
            expected: false,
            label: 'does NOT match when the RIGHT boundary is a word byte (right guard triggered)',
          },
          {
            line: 'hello world',
            expected: true,
            label:
              'matches when at line start and the right boundary is non-word (edge is non-word boundary)',
          },
          {
            line: 'say hello',
            expected: true,
            label:
              'matches when at line end and the left boundary is non-word (edge is non-word boundary)',
          },
        ])('Then $label', ({ line, expected }) => {
          // Arrange
          const sut = buildGrepMatcher([/hello/], { wholeWord: true });
          const encoded = enc(line);

          // Act
          const result = sut.matchLine(encoded);

          // Assert
          expect(result.returned).toBe(expected);
        });
      });
    });

    describe('Given a fixed pattern { fixed: "word" } with wholeWord=true', () => {
      describe('When matchLine is called at a guard or non-word boundary', () => {
        it.each([
          {
            line: 'aword sentence',
            expected: false,
            label:
              'does NOT match when there is a word byte on the left (left guard triggered for fixed form)',
          },
          {
            line: ' worda sentence',
            expected: false,
            label:
              'does NOT match when there is a word byte on the right (right guard triggered for fixed form)',
          },
          {
            line: ' word sentence',
            expected: true,
            label: 'matches when there are non-word boundaries on both sides',
          },
        ])('Then $label', ({ line, expected }) => {
          // Arrange
          const sut = buildGrepMatcher([{ fixed: 'word' }], { wholeWord: true });
          const encoded = enc(line);

          // Act
          const result = sut.matchLine(encoded);

          // Assert
          expect(result.returned).toBe(expected);
        });
      });
    });
  });

  describe('Given invert=true option', () => {
    describe('When matchLine is called', () => {
      it.each([
        {
          patterns: [/hello/],
          line: 'say hello',
          expected: false,
          label: 'a line that matches the pattern returns returned=false with empty spans',
        },
        {
          patterns: [/hello/],
          line: 'no match here',
          expected: true,
          label: 'a line that does NOT match returns returned=true with empty spans',
        },
        {
          // Line matches /bar/ → should be excluded under invert
          patterns: [/foo/, /bar/],
          line: 'contains bar',
          expected: false,
          label: 'a line matching ANY of multiple patterns is excluded (OR-then-invert order)',
        },
        {
          patterns: [/foo/, /bar/],
          line: 'nothing relevant here',
          expected: true,
          label: 'a line matching NO pattern under multiple patterns is included with empty spans',
        },
      ])('Then $label', ({ patterns, line, expected }) => {
        // Arrange
        const sut = buildGrepMatcher(patterns, { invert: true });
        const encoded = enc(line);

        // Act
        const result = sut.matchLine(encoded);

        // Assert
        expect(result.returned).toBe(expected);
        expect(result.spans).toHaveLength(0);
      });
    });
  });

  describe('Given two patterns [/foo/, /bar/]', () => {
    describe('When matchLine is called on a line matching both', () => {
      it('Then returns union of spans in sorted order', () => {
        // Arrange
        const sut = buildGrepMatcher([/foo/, /bar/]);
        const line = enc('foo and bar');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(true);
        expect(result.spans).toEqual([
          { start: 0, end: 3 },
          { start: 8, end: 11 },
        ]);
      });
    });

    describe('When matchLine is called on a line matching only one pattern', () => {
      it('Then returns that pattern spans', () => {
        // Arrange
        const sut = buildGrepMatcher([/foo/, /bar/]);
        const line = enc('only foo here');

        // Act
        const result = sut.matchLine(line);

        // Assert
        const span = result.spans[0];
        expect(result.returned).toBe(true);
        expect(result.spans).toHaveLength(1);
        expect(line.slice(span?.start, span?.end)).toEqual(enc('foo'));
      });
    });

    describe('When both patterns match the SAME span', () => {
      it('Then deduplicates the span', () => {
        // Arrange
        // Both /abc/ and /abc/ would produce identical spans
        const sut = buildGrepMatcher([/abc/, /abc/]);
        const line = enc('xyz abc def');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.spans).toHaveLength(1);
      });
    });
  });

  describe('Given a regex pattern and a fixed pattern together', () => {
    describe('When matchLine is called', () => {
      it('Then returns spans from both patterns as union', () => {
        // Arrange
        const sut = buildGrepMatcher([/foo/, { fixed: 'bar' }]);
        const line = enc('foo and bar');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(true);
        expect(result.spans).toEqual([
          { start: 0, end: 3 },
          { start: 8, end: 11 },
        ]);
      });
    });
  });

  describe('Given an end-anchored regex /c$/', () => {
    describe('When the line ends with LF', () => {
      it('Then anchors at end-of-line (the trailing LF is not part of the content)', () => {
        // Arrange
        const sut = buildGrepMatcher([/c$/]);
        const line = enc('abc\n');

        // Act
        const result = sut.matchLine(line);

        // Assert — git strips the LF before matching, so `$` matches after `c`
        expect(result.returned).toBe(true);
        expect(result.spans).toEqual([{ start: 2, end: 3 }]);
      });
    });

    describe('When the line ends with CRLF', () => {
      it('Then $ does NOT match (the carriage return is kept, like git)', () => {
        // Arrange
        const sut = buildGrepMatcher([/c$/]);
        const line = enc('abc\r\n');

        // Act
        const result = sut.matchLine(line);

        // Assert — only the LF is stripped; the carriage return remains after c
        expect(result.returned).toBe(false);
      });
    });
  });

  describe('Given a regex that can match empty (/x*/)', () => {
    describe('When matchLine scans a line with no x', () => {
      it('Then advances past zero-length matches and reports a match', () => {
        // Arrange
        const sut = buildGrepMatcher([/x*/]);
        const line = enc('abc');

        // Act
        const result = sut.matchLine(line);

        // Assert — empty matches at positions 0..len; the lastIndex advance prevents looping
        expect(result.returned).toBe(true);
        expect(result.spans).toEqual([
          { start: 0, end: 0 },
          { start: 1, end: 1 },
          { start: 2, end: 2 },
          { start: 3, end: 3 },
        ]);
      });
    });
  });

  describe('Given a fixed pattern with an empty string { fixed: "" }', () => {
    describe('When matchLine is called', () => {
      it('Then matches nothing (empty needle yields no spans)', () => {
        // Arrange
        const sut = buildGrepMatcher([{ fixed: '' }]);
        const line = enc('any content');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(false);
        expect(result.spans).toHaveLength(0);
      });
    });
  });

  describe('Given a caller RegExp already carrying the global flag (/o/g)', () => {
    describe('When matchLine is called', () => {
      it('Then finds all occurrences and leaves the caller lastIndex at 0', () => {
        // Arrange
        const caller = /o/g;
        const sut = buildGrepMatcher([caller]);
        const line = enc('foo boo');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.spans).toHaveLength(4);
        expect(caller.lastIndex).toBe(0);
      });
    });
  });

  describe('Given a word byte on the boundary (wholeWord)', () => {
    describe('When the left boundary is a letter, digit, or underscore', () => {
      it.each([
        {
          pattern: { fixed: 'end' },
          line: 'Bend',
          label: 'does NOT match an uppercase letter (uppercase counts as a word byte)',
        },
        {
          pattern: { fixed: 'cat' },
          line: '9cat',
          label: 'does NOT match a digit (a digit is a word byte)',
        },
        {
          pattern: { fixed: 'cat' },
          line: '_cat',
          label: 'does NOT match an underscore (an underscore is a word byte)',
        },
      ])('Then $label', ({ pattern, line }) => {
        // Arrange
        const sut = buildGrepMatcher([pattern], { wholeWord: true });
        const encoded = enc(line);

        // Act
        const result = sut.matchLine(encoded);

        // Assert
        expect(result.returned).toBe(false);
      });
    });
  });

  // ─── isWordByte exact range boundaries (kills ids 154,156,157,164,165,170,172) ─

  describe('Given wholeWord=true and a fixed pattern "end"', () => {
    describe('When the left boundary byte is exactly at a word-byte range edge', () => {
      it.each([
        {
          byte: 0x41,
          expected: false,
          label: 'A (0x41 — lower edge of upper-case range) is a word byte',
        },
        {
          byte: 0x5a,
          expected: false,
          label: 'Z (0x5a — upper edge of upper-case range) is a word byte',
        },
        {
          byte: 0x5b,
          expected: true,
          label: '[ (0x5b — one above Z, just outside upper-case range) is NOT a word byte',
        },
        {
          byte: 0x61,
          expected: false,
          label: 'a (0x61 — lower edge of lower-case range) is a word byte',
        },
        {
          byte: 0x7a,
          expected: false,
          label: 'z (0x7a — upper edge of lower-case range) is a word byte',
        },
        {
          byte: 0x7b,
          expected: true,
          label: '{ (0x7b — one above z, just outside lower-case range) is NOT a word byte',
        },
        {
          byte: 0x30,
          expected: false,
          label: '0 (0x30 — lower edge of digit range) is a word byte',
        },
        {
          byte: 0x39,
          expected: false,
          label: '9 (0x39 — upper edge of digit range) is a word byte',
        },
        {
          byte: 0x3a,
          expected: true,
          label: ': (0x3a — one above 9, just outside digit range) is NOT a word byte',
        },
      ])('Then $label', ({ byte, expected }) => {
        // Arrange
        const sut = buildGrepMatcher([{ fixed: 'end' }], { wholeWord: true });
        const line = new Uint8Array([byte, ...new TextEncoder().encode('end')]);

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(expected);
      });
    });
  });

  // ─── unionSpans sort ordering (kills ids 253, 257, 258, 259) ────────────────

  describe('Given two patterns whose spans need sorting by (start, end)', () => {
    describe('When matchLine returns the union of spans', () => {
      it.each([
        {
          // /bar/ matches at [4,7], /foo/ at [0,3]; must come out start-sorted
          patterns: [/bar/, /foo/],
          line: 'foo bar',
          expected: [
            { start: 0, end: 3 },
            { start: 4, end: 7 },
          ],
          label: 'spans are sorted by start ascending regardless of pattern order',
        },
        {
          // /ab/ matches [0,2], /abc/ matches [0,3]; same start, different end
          patterns: [/ab/, /abc/],
          line: 'abc',
          expected: [
            { start: 0, end: 2 },
            { start: 0, end: 3 },
          ],
          label: 'orders the same-start spans by end ascending',
        },
        {
          // Reversed pattern order from the row above — a "no real sort" bug
          // would return the spans in input order, which is wrong here.
          patterns: [/abc/, /ab/],
          line: 'abc',
          expected: [
            { start: 0, end: 2 },
            { start: 0, end: 3 },
          ],
          label:
            'same-start spans are ordered by end ascending regardless of pattern order (secondary sort key)',
        },
      ])('Then $label', ({ patterns, line, expected }) => {
        // Arrange
        const sut = buildGrepMatcher(patterns);
        const encoded = enc(line);

        // Act
        const result = sut.matchLine(encoded);

        // Assert
        expect(result.spans).toEqual(expected);
      });
    });
  });
});
