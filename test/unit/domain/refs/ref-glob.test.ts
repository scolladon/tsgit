import { describe, expect, it } from 'vitest';
import { compileRefGlob, matchRefGlob } from '../../../../src/domain/refs/ref-glob.js';

describe('matchRefGlob', () => {
  describe('Given a `*` pattern and a nested ref', () => {
    describe('When matching', () => {
      it('Then `*` crosses slashes', () => {
        // Arrange + Act
        const result = matchRefGlob('refs/tags/*', 'refs/tags/rel/v1');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a `?` pattern', () => {
    describe('When matching one character', () => {
      it('Then `?` matches a single character including a slash', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/tags/v?', 'refs/tags/v1')).toBe(true);
        expect(matchRefGlob('a?b', 'a/b')).toBe(true);
      });
    });
  });

  describe('Given a literal pattern', () => {
    describe('When matching', () => {
      it('Then it matches iff the ref is equal', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/tags/v1', 'refs/tags/v1')).toBe(true);
        expect(matchRefGlob('refs/tags/v1', 'refs/tags/v2')).toBe(false);
      });
    });
  });

  describe('Given a pattern that matches only a prefix', () => {
    describe('When matching', () => {
      it('Then the match is anchored at both ends', () => {
        // Arrange + Act
        const result = matchRefGlob('tags/*', 'refs/tags/x');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a pattern with a regex metacharacter', () => {
    describe('When matching', () => {
      it('Then the metacharacter is treated literally', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/tags/v1.0', 'refs/tags/v1.0')).toBe(true);
        expect(matchRefGlob('refs/tags/v1.0', 'refs/tags/v1x0')).toBe(false);
      });
    });
  });

  describe('Given a `\\x` escape', () => {
    describe('When matching', () => {
      it('Then the escaped character is literal, glob meaning included', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('m\\*in', 'm*in')).toBe(true);
        expect(matchRefGlob('m\\*in', 'main')).toBe(false);
      });
    });

    describe('When the escaped character has no glob meaning at all', () => {
      it('Then it behaves exactly like the unescaped character', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('m\\ain', 'main')).toBe(true);
      });
    });
  });

  describe('Given a trailing unescaped backslash', () => {
    describe('When matching any text', () => {
      it('Then the pattern never matches', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/heads/main\\', 'refs/heads/main')).toBe(false);
        expect(matchRefGlob('refs/heads/main\\', '')).toBe(false);
      });
    });
  });

  describe('Given a bracket expression', () => {
    describe('When matching a byte range', () => {
      it('Then a-z matches within the range and rejects outside it', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/heads/m[a-z]in', 'refs/heads/main')).toBe(true);
        expect(matchRefGlob('refs/heads/m[a-z]in', 'refs/heads/mMin')).toBe(false);
      });
    });

    describe('When matching a POSIX class', () => {
      it('Then [:lower:] and [:digit:] match their own byte sets', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/heads/m[[:lower:]]in', 'refs/heads/main')).toBe(true);
        expect(matchRefGlob('refs/heads/m[[:digit:]]in', 'refs/heads/main')).toBe(false);
      });
    });

    describe('When the first member is ]', () => {
      it('Then a literal ] is a member, not the terminator', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/heads/m[]a]in', 'refs/heads/main')).toBe(true);
        expect(matchRefGlob('refs/heads/m[]a]in', 'refs/heads/m]in')).toBe(true);
      });
    });

    describe('When a `-` sits first, last, or right after a range', () => {
      it('Then every such `-` is a literal member, not a range operator', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/heads/m[a-]in', 'refs/heads/m-in')).toBe(true);
        expect(matchRefGlob('refs/heads/m[-a]in', 'refs/heads/m-in')).toBe(true);
        expect(matchRefGlob('refs/heads/m[a-z-]in', 'refs/heads/m-in')).toBe(true);
      });
    });

    describe('When negated with `!` or `^`', () => {
      it('Then a matching byte excludes, and both markers agree', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/heads/m[!a]in', 'refs/heads/main')).toBe(false);
        expect(matchRefGlob('refs/heads/m[^a]in', 'refs/heads/main')).toBe(false);
        expect(matchRefGlob('refs/heads/m[!a]in', 'refs/heads/mXin')).toBe(true);
      });
    });

    describe('When `\\` escapes a member', () => {
      it('Then the escaped character is a literal member, not special', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('m[\\]]n', 'm]n')).toBe(true);
        expect(matchRefGlob('m[\\-]n', 'm-n')).toBe(true);
      });
    });

    describe('When `[:` has no closing `:]`', () => {
      it('Then `[` is treated as an ordinary member', () => {
        // Arrange + Act + Assert — `[:x]` has no ":]" (last char before the
        // found "]" is "x", not ":"), so `[` and `:` and `x` are each members.
        expect(matchRefGlob('m[[:x]n', 'm[n')).toBe(true);
        expect(matchRefGlob('m[[:x]n', 'm:n')).toBe(true);
        expect(matchRefGlob('m[[:x]n', 'mxn')).toBe(true);
        expect(matchRefGlob('m[[:x]n', 'myn')).toBe(false);
      });
    });

    describe('When the class name is unknown', () => {
      it('Then the whole pattern matches nothing', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('m[[:bogus:]]n', 'main')).toBe(false);
        expect(matchRefGlob('m[[:bogus:]]n', '')).toBe(false);
      });
    });

    describe('When the bracket is unterminated', () => {
      it('Then the whole pattern matches nothing, for any text', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/heads/m[a', 'refs/heads/main')).toBe(false);
        expect(matchRefGlob('refs/heads/m[a', '')).toBe(false);
        expect(matchRefGlob('refs/heads/m[a\\', 'refs/heads/main')).toBe(false);
      });
    });

    describe('When the text holds a multi-byte character where a one-byte range is expected', () => {
      it('Then byte length decides the match, not the JS string character count', () => {
        // Arrange — 'méin' is four JS characters, matching "main"'s shape,
        // but 'é' (U+00E9) encodes as two UTF-8 bytes, so the text is five
        // bytes long. A pattern built from four single-byte slots can never
        // match a five-byte text — a per-character engine would get this
        // wrong.
        const pattern = 'refs/heads/m[a-z]in';

        // Act + Assert
        expect(matchRefGlob(pattern, 'refs/heads/main')).toBe(true);
        expect(matchRefGlob(pattern, 'refs/heads/méin')).toBe(false);
      });
    });
  });

  describe('Given repeated calls against one compiled pattern', () => {
    describe('When compileRefGlob is reused', () => {
      it('Then each call answers independently for its own text', () => {
        // Arrange
        const sut = compileRefGlob('refs/heads/m[a-z]in');

        // Act + Assert
        expect(sut('refs/heads/main')).toBe(true);
        expect(sut('refs/heads/moin')).toBe(true);
        expect(sut('refs/heads/mMin')).toBe(false);
      });
    });
  });
});
