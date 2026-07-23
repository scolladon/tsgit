import { describe, expect, it } from 'vitest';

import {
  parseGitignore,
  tokenizeIgnoreLine,
} from '../../../../src/domain/ignore/parse-gitignore.js';

describe('parseGitignore', () => {
  describe('Given input containing no effective rule', () => {
    describe('When parsed', () => {
      it.each([
        { input: '', label: 'empty input yields zero rules' },
        { input: '# this is a comment\n', label: 'a comment-only line yields zero rules' },
        { input: '\n   \n\n', label: 'a blank-only line yields zero rules' },
        // A line of only spaces (no escape) → stripTrailingSpaces returns ''.
        {
          input: '   \n',
          label: 'a line that becomes empty after trailing-space strip yields zero rules',
        },
      ])('Then $label', ({ input }) => {
        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given "build/"', () => {
    describe('When parsed', () => {
      it('Then yields one directory-only rule', () => {
        // Arrange
        const input = 'build/';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.directoryOnly).toBe(true);
        expect(sut[0]?.negated).toBe(false);
        expect(sut[0]?.pattern).toBe('build/');
      });
    });
  });

  describe('Given "*.log"', () => {
    describe('When parsed', () => {
      it('Then yields one rule that matches "foo.log"', () => {
        // Arrange
        const input = '*.log';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.compiled.test('foo.log')).toBe(true);
        expect(sut[0]?.compiled.test('foo/log')).toBe(false);
      });
    });
  });

  describe('Given "!**/*.keep"', () => {
    describe('When parsed', () => {
      it('Then yields one negated rule', () => {
        // Arrange
        const input = '!**/*.keep';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.negated).toBe(true);
        expect(sut[0]?.pattern).toBe('!**/*.keep');
      });
    });
  });

  describe('Given a pattern with a given slash position', () => {
    describe('When parsed', () => {
      it.each([
        { input: '/dist', expected: true, label: 'a leading slash makes the pattern anchored' },
        // Kills the `||` -> `&&` LogicalOperator mutant on the `anchored`
        // expression: `startsWith('/')` is false here, `includes('/')` is
        // true, so `||` yields true while `&&` would yield false.
        {
          input: 'a/b',
          expected: true,
          label: 'a slash only in the middle makes the pattern anchored',
        },
        // Complements the `a/b` row: with no slash, `anchored` is false —
        // pins that `includes('/')` actually drives the result.
        {
          input: 'plain',
          expected: false,
          label: 'no slash anywhere leaves the pattern NOT anchored',
        },
      ])('Then $label', ({ input, expected }) => {
        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.anchored).toBe(expected);
      });
    });
  });

  describe('Given a line with a trailing space, escaped or not', () => {
    describe('When parsed', () => {
      it.each([
        { input: 'foo   \n', expected: 'foo', label: 'unescaped trailing spaces are stripped' },
        // `foo` followed by exactly one space, no backslash. The
        // backslash-escape guard inside the trim loop must NOT break here:
        // charCodeAt(end-2) is 'o' (0x6f), not '\' (0x5c), so the loop must
        // proceed and strip the space. A mutant that forces an immediate
        // `break` leaves the pattern as `foo ` instead of `foo`.
        {
          input: 'foo ',
          expected: 'foo',
          label: 'a single unescaped trailing space is stripped',
        },
        { input: 'foo\\ \n', expected: 'foo ', label: 'an escaped trailing space is preserved' },
        // Line is exactly backslash + space (length 2). stripTrailingSpaces
        // starts at end=2; the `end >= 2` guard must hold so it inspects
        // charCodeAt(0)===0x5c and breaks, preserving the space. The
        // `end > 2` mutant would make `2 > 2` false → no break → space
        // stripped → pattern '\'.
        {
          input: '\\ ',
          expected: ' ',
          label: 'a bare escaped space (length-2 line) is preserved',
        },
      ])('Then $label', ({ input, expected }) => {
        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.pattern).toBe(expected);
      });
    });
  });

  describe('Given an escaped # at line start', () => {
    describe('When parsed', () => {
      it('Then yields a literal-# rule (not a comment)', () => {
        // Arrange
        const input = '\\#literal';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.pattern).toBe('#literal');
      });
    });
  });

  describe('Given a "?" glob', () => {
    describe('When parsed', () => {
      it('Then matches a single non-slash character', () => {
        // Arrange
        const input = 'foo?.txt';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.compiled.test('foo1.txt')).toBe(true);
        expect(sut[0]?.compiled.test('foo.txt')).toBe(false);
        expect(sut[0]?.compiled.test('foo/.txt')).toBe(false);
      });
    });
  });

  describe('Given "**foo" (no slash after **)', () => {
    describe('When parsed', () => {
      it('Then the ** consumes only itself', () => {
        // Arrange
        const input = '**foo';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.compiled.test('barfoo')).toBe(true);
        expect(sut[0]?.compiled.test('a/b/foobar')).toBe(false);
      });
    });
  });

  describe('Given "**" followed by "/foo"', () => {
    describe('When parsed', () => {
      it('Then the slash after ** is consumed', () => {
        // Arrange
        const input = '**/foo';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.compiled.test('foo')).toBe(true);
        expect(sut[0]?.compiled.test('a/b/foo')).toBe(true);
      });
    });
  });

  describe('Given a pattern with regex specials (parens, brackets)', () => {
    describe('When parsed', () => {
      it('Then they are escaped', () => {
        // Arrange
        const input = 'a(b).txt';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.compiled.test('a(b).txt')).toBe(true);
        expect(sut[0]?.compiled.test('ab.txt')).toBe(false);
      });
    });
  });

  describe('Given multiple lines mixing comments + rules', () => {
    describe('When parsed', () => {
      it('Then yields only the rules', () => {
        // Arrange
        const input = '# header\n\n*.log\nbuild/\n!important.log\n# trailing comment\n';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(3);
        expect(sut[0]?.pattern).toBe('*.log');
        expect(sut[1]?.directoryOnly).toBe(true);
        expect(sut[2]?.negated).toBe(true);
      });
    });
  });

  describe('Given multiple lines with comments and blanks', () => {
    describe('When parsed', () => {
      it('Then every rule carries its 1-based source line number', () => {
        // Arrange — three rules on lines 3, 4, 5 of the source. Line numbers
        // are 1-based and track the SOURCE position, not the rule index.
        const input = '# header\n\n*.log\nbuild/\n!important.log\n# trailing\n';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut[0]?.lineNumber).toBe(3);
        expect(sut[1]?.lineNumber).toBe(4);
        expect(sut[2]?.lineNumber).toBe(5);
      });
    });
  });

  describe('Given a single rule on line 1', () => {
    describe('When parsed', () => {
      it('Then lineNumber is 1 (kills off-by-one mutants)', () => {
        // Arrange — the simplest case pins that the parser uses 1-based
        // indexing, not 0-based.
        const input = '*.log';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut[0]?.lineNumber).toBe(1);
      });
    });
  });
});

describe('tokenizeIgnoreLine', () => {
  describe('Given a line with no effective pattern', () => {
    describe('When tokenized', () => {
      it.each([
        { input: '', label: 'an empty line yields undefined' },
        { input: '   ', label: 'a whitespace-only line yields undefined' },
        { input: '# a comment', label: 'a comment line yields undefined' },
      ])('Then $label', ({ input }) => {
        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a plain pattern', () => {
    describe('When tokenized', () => {
      it('Then no flags are set', () => {
        // Arrange
        const input = 'plain';

        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut).toEqual({
          negated: false,
          anchored: false,
          directoryOnly: false,
          cleanPattern: 'plain',
        });
      });
    });
  });

  describe('Given a "!"-prefixed pattern', () => {
    describe('When tokenized', () => {
      it('Then negated is true and the "!" is stripped', () => {
        // Arrange
        const input = '!keep.txt';

        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut?.negated).toBe(true);
        expect(sut?.cleanPattern).toBe('keep.txt');
      });
    });
  });

  describe('Given a leading-slash pattern', () => {
    describe('When tokenized', () => {
      it('Then anchored is true and the slash is stripped', () => {
        // Arrange
        const input = '/dist';

        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut?.anchored).toBe(true);
        expect(sut?.cleanPattern).toBe('dist');
      });
    });
  });

  describe('Given a mid-slash pattern', () => {
    describe('When tokenized', () => {
      it('Then anchored is true and no slash is stripped', () => {
        // Arrange
        const input = 'a/b';

        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut?.anchored).toBe(true);
        expect(sut?.cleanPattern).toBe('a/b');
      });
    });
  });

  describe('Given a trailing-slash pattern', () => {
    describe('When tokenized', () => {
      it('Then directoryOnly is true and the slash is stripped', () => {
        // Arrange
        const input = 'build/';

        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut?.directoryOnly).toBe(true);
        expect(sut?.cleanPattern).toBe('build');
      });
    });
  });

  describe('Given an escaped pattern', () => {
    describe('When tokenized', () => {
      it('Then the escape is removed from cleanPattern', () => {
        // Arrange
        const input = '\\#literal';

        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut?.cleanPattern).toBe('#literal');
      });
    });
  });

  describe('Given a trailing-space pattern', () => {
    describe('When tokenized', () => {
      it('Then the trailing space is stripped', () => {
        // Arrange
        const input = 'foo   ';

        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut?.cleanPattern).toBe('foo');
      });
    });
  });

  describe('Given a negated directory-only anchored pattern', () => {
    describe('When tokenized', () => {
      it('Then all three flags are set', () => {
        // Arrange
        const input = '!/src/';

        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut).toEqual({
          negated: true,
          anchored: true,
          directoryOnly: true,
          cleanPattern: 'src',
        });
      });
    });
  });
});
