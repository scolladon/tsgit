import { describe, expect, it } from 'vitest';
import { buildGrepMatcher, type MatchSpan } from '../../../../src/domain/grep/matcher.js';

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
      describe('When matchLine is called and LEFT boundary is a word byte', () => {
        it('Then does NOT match (left guard triggered)', () => {
          // Arrange
          const sut = buildGrepMatcher([/hello/], { wholeWord: true });
          // 'xhello world' — 'x' before 'hello' is a word byte
          const line = enc('xhello world');

          // Act
          const result = sut.matchLine(line);

          // Assert
          expect(result.returned).toBe(false);
        });
      });

      describe('When matchLine is called and RIGHT boundary is a word byte', () => {
        it('Then does NOT match (right guard triggered)', () => {
          // Arrange
          const sut = buildGrepMatcher([/hello/], { wholeWord: true });
          // ' hellox' — 'x' after 'hello' is a word byte
          const line = enc(' hellox world');

          // Act
          const result = sut.matchLine(line);

          // Assert
          expect(result.returned).toBe(false);
        });
      });

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

      describe('When match is at line start and right boundary is non-word', () => {
        it('Then matches (edge is non-word boundary)', () => {
          // Arrange
          const sut = buildGrepMatcher([/hello/], { wholeWord: true });
          const line = enc('hello world');

          // Act
          const result = sut.matchLine(line);

          // Assert
          expect(result.returned).toBe(true);
        });
      });

      describe('When match is at line end and left boundary is non-word', () => {
        it('Then matches (edge is non-word boundary)', () => {
          // Arrange
          const sut = buildGrepMatcher([/hello/], { wholeWord: true });
          const line = enc('say hello');

          // Act
          const result = sut.matchLine(line);

          // Assert
          expect(result.returned).toBe(true);
        });
      });
    });

    describe('Given a fixed pattern { fixed: "word" } with wholeWord=true', () => {
      describe('When the fixed match has a word byte on the left', () => {
        it('Then does NOT match (left guard triggered for fixed form)', () => {
          // Arrange
          const sut = buildGrepMatcher([{ fixed: 'word' }], { wholeWord: true });
          const line = enc('aword sentence');

          // Act
          const result = sut.matchLine(line);

          // Assert
          expect(result.returned).toBe(false);
        });
      });

      describe('When the fixed match has a word byte on the right', () => {
        it('Then does NOT match (right guard triggered for fixed form)', () => {
          // Arrange
          const sut = buildGrepMatcher([{ fixed: 'word' }], { wholeWord: true });
          const line = enc(' worda sentence');

          // Act
          const result = sut.matchLine(line);

          // Assert
          expect(result.returned).toBe(false);
        });
      });

      describe('When the fixed match has non-word boundaries on both sides', () => {
        it('Then matches', () => {
          // Arrange
          const sut = buildGrepMatcher([{ fixed: 'word' }], { wholeWord: true });
          const line = enc(' word sentence');

          // Act
          const result = sut.matchLine(line);

          // Assert
          expect(result.returned).toBe(true);
        });
      });
    });
  });

  describe('Given invert=true option', () => {
    describe('When matchLine is called on a line that matches the pattern', () => {
      it('Then returned=false with empty spans', () => {
        // Arrange
        const sut = buildGrepMatcher([/hello/], { invert: true });
        const line = enc('say hello');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(false);
        expect(result.spans).toHaveLength(0);
      });
    });

    describe('When matchLine is called on a line that does NOT match', () => {
      it('Then returned=true with empty spans', () => {
        // Arrange
        const sut = buildGrepMatcher([/hello/], { invert: true });
        const line = enc('no match here');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(true);
        expect(result.spans).toHaveLength(0);
      });
    });

    describe('When a line matches ANY of multiple patterns', () => {
      it('Then invert excludes it (OR-then-invert order)', () => {
        // Arrange
        const sut = buildGrepMatcher([/foo/, /bar/], { invert: true });
        // Line matches /bar/ → should be excluded under invert
        const line = enc('contains bar');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(false);
        expect(result.spans).toHaveLength(0);
      });
    });

    describe('When a line matches NO pattern under multiple patterns', () => {
      it('Then invert includes it with empty spans', () => {
        // Arrange
        const sut = buildGrepMatcher([/foo/, /bar/], { invert: true });
        const line = enc('nothing relevant here');

        // Act
        const result = sut.matchLine(line);

        // Assert
        expect(result.returned).toBe(true);
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
        expect(result.spans.length).toBeGreaterThanOrEqual(2);
        // spans sorted by start
        const starts = result.spans.map((s: MatchSpan) => s.start);
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
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
        expect(result.spans.length).toBeGreaterThanOrEqual(2);
      });
    });
  });
});
