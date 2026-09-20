import { describe, expect, it } from 'vitest';
import { compileRefGlob, matchRefGlob } from '../../../../src/domain/refs/ref-glob.js';

const CLASS_MEMBERSHIP_ROWS = [
  { className: 'alnum', members: ['a', '9'], nonMembers: ['_'] },
  { className: 'alpha', members: ['A', 'Z', 'a', 'z'], nonMembers: ['@', '[', '`', '{'] },
  { className: 'blank', members: [' ', '\t'], nonMembers: ['\v'] },
  { className: 'cntrl', members: ['\x1f', '\x7f'], nonMembers: [' ', '~'] },
  { className: 'digit', members: ['0', '9'], nonMembers: ['/', ':'] },
  { className: 'graph', members: ['!', '~'], nonMembers: [' ', '\x7f'] },
  { className: 'lower', members: ['a', 'z'], nonMembers: ['`', '{', 'A'] },
  { className: 'print', members: [' ', '~'], nonMembers: ['\x1f', '\x7f'] },
  { className: 'punct', members: ['!', '~'], nonMembers: ['A', '0', ' '] },
  { className: 'space', members: [' ', '\t', '\n', '\r'], nonMembers: ['\b', '\v', '\f', '\x0e'] },
  { className: 'upper', members: ['A', 'Z'], nonMembers: ['@', '[', 'a'] },
  {
    className: 'xdigit',
    members: ['0', '9', 'A', 'F', 'a', 'f'],
    nonMembers: ['/', ':', '@', 'G', '`', 'g'],
  },
] as const;

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

  describe('Given a run of consecutive `*`', () => {
    describe('When matching', () => {
      it('Then the run behaves as a single `*`, matching any bytes or none', () => {
        // Arrange
        const sut = matchRefGlob;

        // Act
        const results = ['mn', 'm/x/n', 'mxn', 'mx'].map((text) => sut('m***n', text));

        // Assert
        expect(results).toEqual([true, true, true, false]);
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

    describe('When a set is negated', () => {
      it('Then neither the marker nor the opening bracket becomes a member', () => {
        // Arrange
        const sut = matchRefGlob;

        // Act
        const openingBracket = sut('refs/heads/m[!a]in', 'refs/heads/m[in');
        const bangMarker = sut('refs/heads/m[!a]in', 'refs/heads/m!in');
        const caretMarker = sut('refs/heads/m[^a]in', 'refs/heads/m^in');

        // Assert
        expect(openingBracket).toBe(true);
        expect(bangMarker).toBe(true);
        expect(caretMarker).toBe(true);
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

    describe('When `[` is a member and the set closes right after it', () => {
      it('Then `[` stays an ordinary member instead of opening a class', () => {
        // Arrange
        const sut = matchRefGlob;

        // Act
        const member = sut('m[[]n', 'm[n');
        const nonMember = sut('m[[]n', 'man');

        // Assert
        expect(member).toBe(true);
        expect(nonMember).toBe(false);
      });
    });

    describe('When a member is followed by `:` outside any class', () => {
      it('Then the member, the `:` and its successor are three ordinary members', () => {
        // Arrange
        const sut = matchRefGlob;

        // Act
        const beforeColon = sut('m[a:b]n', 'man');
        const theColon = sut('m[a:b]n', 'm:n');
        const afterColon = sut('m[a:b]n', 'mbn');
        const openingBracket = sut('m[a:b]n', 'm[n');

        // Assert
        expect(beforeColon).toBe(true);
        expect(theColon).toBe(true);
        expect(afterColon).toBe(true);
        expect(openingBracket).toBe(false);
      });
    });

    describe('When a class opens right after a literal `]` member', () => {
      it('Then the class name is read from its own `[:`, not from the earlier `]`', () => {
        // Arrange
        const sut = matchRefGlob;

        // Act
        const bracketMember = sut('m[][:alpha:]]n', 'm]n');
        const classMember = sut('m[][:alpha:]]n', 'man');
        const outsideBoth = sut('m[][:alpha:]]n', 'm1n');

        // Assert
        expect(bracketMember).toBe(true);
        expect(classMember).toBe(true);
        expect(outsideBoth).toBe(false);
      });
    });

    describe('When matching each POSIX class against bytes on both sides of it', () => {
      it.each(CLASS_MEMBERSHIP_ROWS)(
        'Then the $className class admits exactly its own members',
        ({ className, members, nonMembers }) => {
          // Arrange
          const sut = matchRefGlob;
          const pattern = `m[[:${className}:]]n`;

          // Act
          const admitted = members.map((byte) => sut(pattern, `m${byte}n`));
          const refused = nonMembers.map((byte) => sut(pattern, `m${byte}n`));

          // Assert
          expect(admitted.every(Boolean)).toBe(true);
          expect(refused.some(Boolean)).toBe(false);
        },
      );
    });

    describe('When `[:` opens right before the set closes', () => {
      it('Then `[` and `:` are ordinary members of a negated set', () => {
        // Arrange
        const sut = matchRefGlob;

        // Act
        const nonMember = sut('refs/heads/m[![:]in', 'refs/heads/main');
        const member = sut('refs/heads/m[![:]in', 'refs/heads/m:in');

        // Assert
        expect(nonMember).toBe(true);
        expect(member).toBe(false);
      });
    });

    describe('When a `[:` class never finds a closing `]`', () => {
      it('Then the whole pattern matches nothing', () => {
        // Arrange
        const sut = matchRefGlob;

        // Act
        const results = ['m[:abc', 'ma', 'm'].map((text) => sut('m[[:abc', text));

        // Assert
        expect(results).toEqual([false, false, false]);
      });
    });

    describe('When the class name between `[:` and `:]` is empty', () => {
      it('Then the whole pattern matches nothing', () => {
        // Arrange
        const sut = matchRefGlob;

        // Act
        const results = ['m:n', 'm]n', 'mn', 'm:]n', 'm[]n'].map((text) => sut('m[[::]]n', text));

        // Assert
        expect(results).toEqual([false, false, false, false, false]);
      });
    });

    describe('When a range bound is an escaped `]`', () => {
      it('Then `]` is the bound and the next `]` closes the set', () => {
        // Arrange
        const sut = matchRefGlob;

        // Act
        const atBound = sut('m[#-\\]]in', 'm]in');
        const withinRange = sut('m[#-\\]]in', 'mAin');
        const beyond = sut('m[#-\\]]in', 'm^in');

        // Assert
        expect(atBound).toBe(true);
        expect(withinRange).toBe(true);
        expect(beyond).toBe(false);
      });
    });

    describe('When the pattern ends right after `[`, `[!`, or an escaping range bound', () => {
      it.each([
        { pattern: 'm[', texts: ['m[', 'm', 'ma'] },
        { pattern: 'm[!', texts: ['m[!', 'm!', 'ma'] },
        { pattern: 'm[a-\\', texts: ['m[a-\\', 'ma', 'm\\'] },
      ])('Then $pattern matches nothing', ({ pattern, texts }) => {
        // Arrange
        const sut = matchRefGlob;

        // Act
        const results = texts.map((text) => sut(pattern, text));

        // Assert
        expect(results).toEqual([false, false, false]);
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
