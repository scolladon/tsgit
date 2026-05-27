import { describe, expect, it } from 'vitest';

import {
  parseGitignore,
  tokenizeIgnoreLine,
} from '../../../../src/domain/ignore/parse-gitignore.js';

describe('parseGitignore', () => {
  describe('Given empty input', () => {
    describe('When parsed', () => {
      it('Then yields zero rules', () => {
        // Arrange
        const input = '';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given only a comment line', () => {
    describe('When parsed', () => {
      it('Then yields zero rules', () => {
        // Arrange
        const input = '# this is a comment\n';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given only a blank line', () => {
    describe('When parsed', () => {
      it('Then yields zero rules', () => {
        // Arrange
        const input = '\n   \n\n';

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

  describe('Given "/dist"', () => {
    describe('When parsed', () => {
      it('Then yields one anchored rule', () => {
        // Arrange
        const input = '/dist';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.anchored).toBe(true);
      });
    });
  });

  describe('Given a line with trailing spaces', () => {
    describe('When parsed', () => {
      it('Then trailing spaces stripped from pattern', () => {
        // Arrange
        const input = 'foo   \n';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.pattern).toBe('foo');
      });
    });
  });

  describe('Given "foo " (one unescaped trailing space)', () => {
    describe('When parsed', () => {
      it('Then the trailing space is stripped', () => {
        // Arrange — `foo` followed by exactly one space, no backslash. The
        // backslash-escape guard inside the trim loop must NOT break here:
        // charCodeAt(end-2) is 'o' (0x6f), not '\' (0x5c), so the loop must
        // proceed and strip the space. A mutant that forces an immediate
        // `break` leaves the pattern as `foo ` instead of `foo`.
        const input = 'foo ';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.pattern).toBe('foo');
      });
    });
  });

  describe('Given a line with escaped trailing space', () => {
    describe('When parsed', () => {
      it('Then escaped space is preserved', () => {
        // Arrange
        const input = 'foo\\ \n';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.pattern).toBe('foo ');
      });
    });
  });

  describe('Given a two-char line of escaped space "\\\\ "', () => {
    describe('When parsed', () => {
      it('Then the escaped space is preserved', () => {
        // Arrange — line is exactly backslash + space (length 2). stripTrailingSpaces
        // starts at end=2; the `end >= 2` guard must hold so it inspects
        // charCodeAt(0)===0x5c and breaks, preserving the space. The `end > 2`
        // mutant would make `2 > 2` false → no break → space stripped → pattern '\'.
        const input = '\\ ';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.pattern).toBe(' ');
      });
    });
  });

  describe('Given "a/b" (slash only in the middle)', () => {
    describe('When parsed', () => {
      it('Then the rule is anchored', () => {
        // Arrange — kills the `||` -> `&&` LogicalOperator mutant on the `anchored`
        // expression: `startsWith('/')` is false here, `includes('/')` is true, so
        // `||` yields true while `&&` would yield false.
        const input = 'a/b';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.anchored).toBe(true);
      });
    });
  });

  describe('Given "plain" (no slash anywhere)', () => {
    describe('When parsed', () => {
      it('Then the rule is NOT anchored', () => {
        // Arrange — complements the `a/b` case: with no slash, `anchored` is false.
        // Pins that `includes('/')` actually drives the result.
        const input = 'plain';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.anchored).toBe(false);
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

  describe('Given a line that becomes empty after trailing-space strip', () => {
    describe('When parsed', () => {
      it('Then yields no rule', () => {
        // Arrange — a line of only spaces (no escape) → stripTrailingSpaces returns ''
        const input = '   \n';

        // Act
        const sut = parseGitignore(input);

        // Assert
        expect(sut).toEqual([]);
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
  describe('Given an empty line', () => {
    describe('When tokenized', () => {
      it('Then yields undefined', () => {
        // Arrange
        const input = '';

        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a whitespace-only line', () => {
    describe('When tokenized', () => {
      it('Then yields undefined', () => {
        // Arrange
        const input = '   ';

        // Act
        const sut = tokenizeIgnoreLine(input);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a comment line', () => {
    describe('When tokenized', () => {
      it('Then yields undefined', () => {
        // Arrange
        const input = '# a comment';

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
