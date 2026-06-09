import { describe, expect, it } from 'vitest';

import type { AttributeValue } from '../../../../src/domain/attributes/index.js';
import { parseGitattributes } from '../../../../src/domain/attributes/index.js';

const attrs = (entries: ReadonlyMap<string, AttributeValue>): Record<string, AttributeValue> =>
  Object.fromEntries(entries);

describe('parseGitattributes', () => {
  describe('Given empty input', () => {
    describe('When parsed', () => {
      it('Then yields zero rules and zero macros', () => {
        // Arrange
        const input = '';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut).toEqual({ rules: [], macros: [] });
      });
    });
  });

  describe('Given a comment line', () => {
    describe('When parsed', () => {
      it('Then is skipped', () => {
        // Arrange
        const input = '# a comment\n';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules).toEqual([]);
      });
    });
  });

  describe('Given a blank line', () => {
    describe('When parsed', () => {
      it('Then is skipped', () => {
        // Arrange
        const input = '   \n';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules).toEqual([]);
      });
    });
  });

  describe('Given a set attribute (`name`)', () => {
    describe('When parsed', () => {
      it('Then the attribute is true', () => {
        // Arrange
        const input = '*.txt text';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules).toHaveLength(1);
        expect(sut.rules[0]!.pattern).toBe('*.txt');
        expect(attrs(sut.rules[0]!.attributes)).toEqual({ text: true });
      });
    });
  });

  describe('Given an unset attribute (`-name`)', () => {
    describe('When parsed', () => {
      it('Then the attribute is false', () => {
        // Arrange
        const input = '*.bin -merge';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(attrs(sut.rules[0]!.attributes)).toEqual({ merge: false });
      });
    });
  });

  describe('Given an unspecified attribute (`!name`)', () => {
    describe('When parsed', () => {
      it("Then the attribute is 'unspecified'", () => {
        // Arrange
        const input = 'file !diff';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(attrs(sut.rules[0]!.attributes)).toEqual({ diff: 'unspecified' });
      });
    });
  });

  describe('Given a valued attribute (`name=value`)', () => {
    describe('When parsed', () => {
      it('Then the attribute carries the string value', () => {
        // Arrange
        const input = '*.c merge=union';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(attrs(sut.rules[0]!.attributes)).toEqual({ merge: { set: 'union' } });
      });
    });

    describe('When the value is empty (`name=`)', () => {
      it('Then the value is the empty string', () => {
        // Arrange
        const input = '*.c merge=';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(attrs(sut.rules[0]!.attributes)).toEqual({ merge: { set: '' } });
      });
    });
  });

  describe('Given multiple attributes on one line', () => {
    describe('When parsed', () => {
      it('Then all are recorded', () => {
        // Arrange
        const input = '*.png -diff -merge';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(attrs(sut.rules[0]!.attributes)).toEqual({ diff: false, merge: false });
      });
    });
  });

  describe('Given the same attribute twice on one line', () => {
    describe('When parsed', () => {
      it('Then the last token wins', () => {
        // Arrange
        const input = 'f merge merge=custom';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(attrs(sut.rules[0]!.attributes)).toEqual({ merge: { set: 'custom' } });
      });
    });
  });

  describe('Given a pattern with no attributes', () => {
    describe('When parsed', () => {
      it('Then a rule with an empty attribute map is kept', () => {
        // Arrange
        const input = '*.txt';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules).toHaveLength(1);
        expect(attrs(sut.rules[0]!.attributes)).toEqual({});
      });
    });
  });

  describe('Given dash-only / bang-only / equals-only tokens', () => {
    describe('When parsed', () => {
      it('Then each malformed token is dropped', () => {
        // Arrange
        const input = '*.x - ! =v text';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(attrs(sut.rules[0]!.attributes)).toEqual({ text: true });
      });
    });
  });

  describe('Given a macro definition (`[attr]name ...`)', () => {
    describe('When parsed', () => {
      it('Then it becomes a macro, not a rule', () => {
        // Arrange
        const input = '[attr]binary -diff -merge -text';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules).toEqual([]);
        expect(sut.macros).toHaveLength(1);
        expect(sut.macros[0]!.name).toBe('binary');
        expect(attrs(sut.macros[0]!.attributes)).toEqual({
          diff: false,
          merge: false,
          text: false,
        });
      });
    });
  });

  describe('Given an unanchored pattern (no slash)', () => {
    describe('When parsed', () => {
      it('Then anchored is false and it matches at any depth', () => {
        // Arrange
        const input = '*.txt text';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules[0]!.anchored).toBe(false);
        expect(sut.rules[0]!.compiled.test('a/b/c.txt')).toBe(true);
      });
    });
  });

  describe('Given a pattern with an interior slash', () => {
    describe('When parsed', () => {
      it('Then anchored is true', () => {
        // Arrange
        const input = 'sub/dir/*.txt text';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules[0]!.anchored).toBe(true);
        expect(sut.rules[0]!.compiled.test('sub/dir/x.txt')).toBe(true);
      });
    });
  });

  describe('Given a leading-slash pattern', () => {
    describe('When parsed', () => {
      it('Then anchored is true and the slash is stripped from the compiled body', () => {
        // Arrange
        const input = '/top text';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules[0]!.anchored).toBe(true);
        expect(sut.rules[0]!.compiled.test('top')).toBe(true);
        expect(sut.rules[0]!.compiled.test('a/top')).toBe(false);
      });
    });
  });

  describe('Given a directory-only pattern (trailing slash)', () => {
    describe('When parsed', () => {
      it('Then directoryOnly is true', () => {
        // Arrange
        const input = 'build/ -merge';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules[0]!.directoryOnly).toBe(true);
        expect(attrs(sut.rules[0]!.attributes)).toEqual({ merge: false });
      });
    });
  });

  describe('Given a double-quoted pattern containing a space', () => {
    describe('When parsed', () => {
      it('Then the quotes are removed and the space is preserved', () => {
        // Arrange
        const input = '"with space.txt" text';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules[0]!.pattern).toBe('with space.txt');
        expect(attrs(sut.rules[0]!.attributes)).toEqual({ text: true });
      });
    });

    describe('When the quoted pattern carries C-style escapes', () => {
      it('Then the escapes are decoded', () => {
        // Arrange
        const input = '"tab\\ttext\\\\end" text';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules[0]!.pattern).toBe('tab\ttext\\end');
      });

      it('Then `\\n` and `\\r` decode to newline and carriage return', () => {
        // Arrange
        const input = '"a\\nb\\rc" text';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules[0]!.pattern).toBe('a\nb\rc');
      });
    });

    describe('When the quoted pattern ends with a dangling backslash', () => {
      it('Then parsing stops at the backslash', () => {
        // Arrange
        const input = '"ab\\';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules[0]!.pattern).toBe('ab');
      });
    });
  });

  describe('Given a macro header with no name (`[attr]` alone)', () => {
    describe('When parsed', () => {
      it('Then no macro is recorded', () => {
        // Arrange
        const input = '[attr]   ';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut).toEqual({ rules: [], macros: [] });
      });
    });
  });

  describe('Given comment / blank lines interleaved with rules', () => {
    describe('When parsed', () => {
      it('Then lineNumber tracks the source line', () => {
        // Arrange
        const input = '# comment\n\n*.txt text\n*.bin -merge';

        // Act
        const sut = parseGitattributes(input);

        // Assert
        expect(sut.rules.map((r) => r.lineNumber)).toEqual([3, 4]);
      });
    });
  });
});
