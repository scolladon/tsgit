import { describe, expect, it } from 'vitest';

import type { AttributeSource } from '../../../../src/domain/attributes/index.js';
import {
  BUILTIN_MACROS,
  buildMacroRegistry,
  expandAttributes,
  parseGitattributes,
  resolveAttribute,
} from '../../../../src/domain/attributes/index.js';

const sourceAt = (basedir: string, text: string): AttributeSource => ({
  basedir,
  rules: parseGitattributes(text).rules,
});

describe('resolveAttribute', () => {
  describe('Given no sources', () => {
    describe('When resolving any attribute', () => {
      it("Then yields 'unspecified'", () => {
        // Arrange
        const sources: ReadonlyArray<AttributeSource> = [];

        // Act
        const sut = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toBe('unspecified');
      });
    });
  });

  describe('Given a single matching set rule', () => {
    describe('When resolving the attribute', () => {
      it('Then yields the set value', () => {
        // Arrange
        const sources = [sourceAt('', '*.txt merge=custom')];

        // Act
        const sut = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toEqual({ set: 'custom' });
      });
    });
  });

  describe('Given a non-matching rule', () => {
    describe('When resolving the attribute', () => {
      it("Then yields 'unspecified'", () => {
        // Arrange
        const sources = [sourceAt('', '*.bin merge=custom')];

        // Act
        const sut = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toBe('unspecified');
      });
    });
  });

  describe('Given two matching rules in one source', () => {
    describe('When resolving the attribute', () => {
      it('Then the last match wins', () => {
        // Arrange
        const sources = [sourceAt('', '*.txt merge=first\na.txt -merge')];

        // Act
        const sut = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given two sources both assigning the attribute', () => {
    describe('When resolving', () => {
      it('Then the higher-precedence (earlier) source wins', () => {
        // Arrange
        const sources = [sourceAt('', '*.txt merge=high'), sourceAt('', '*.txt merge=low')];

        // Act
        const sut = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toEqual({ set: 'high' });
      });
    });
  });

  describe('Given a higher source that does not assign the attribute', () => {
    describe('When resolving', () => {
      it('Then the lower source supplies the value', () => {
        // Arrange
        const sources = [sourceAt('', '*.txt text'), sourceAt('', '*.txt merge=low')];

        // Act
        const sut = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toEqual({ set: 'low' });
      });
    });
  });

  describe('Given an explicit unspecified (`!merge`) in the higher source', () => {
    describe('When resolving', () => {
      it("Then yields 'unspecified' and shadows lower sources", () => {
        // Arrange
        const sources = [sourceAt('', '*.txt !merge'), sourceAt('', '*.txt merge=low')];

        // Act
        const sut = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toBe('unspecified');
      });
    });
  });

  describe('Given a source rooted in a subdirectory', () => {
    describe('When the path lies under that basedir', () => {
      it('Then the pattern matches relative to the basedir', () => {
        // Arrange
        const sources = [sourceAt('a/b', '*.txt merge=sub')];

        // Act
        const sut = resolveAttribute(sources, 'a/b/c.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toEqual({ set: 'sub' });
      });
    });

    describe('When the path lies outside that basedir', () => {
      it('Then the source is skipped', () => {
        // Arrange
        const sources = [sourceAt('a/b', '*.txt merge=sub')];

        // Act
        const sut = resolveAttribute(sources, 'a/x.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toBe('unspecified');
      });
    });

    describe('When an anchored pattern only matches the basedir-relative path', () => {
      it('Then the match is against the stripped path, not the full path', () => {
        // Arrange — `x/c.txt` is anchored (interior slash); it must be matched
        // against `x/c.txt` (relative to `a/b`), never `a/b/x/c.txt`.
        const sources = [sourceAt('a/b', 'x/c.txt merge=anchored')];

        // Act
        const sut = resolveAttribute(sources, 'a/b/x/c.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toEqual({ set: 'anchored' });
      });
    });
  });

  describe('Given a later matching rule that does not assign the attribute', () => {
    describe('When resolving', () => {
      it('Then the earlier assignment is retained (the non-assigning match is ignored)', () => {
        // Arrange — rule 1 sets merge; rule 2 also matches but only sets `text`.
        const sources = [sourceAt('', '* merge=keep\n* text')];

        // Act
        const sut = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toEqual({ set: 'keep' });
      });
    });
  });

  describe('Given the built-in `binary` macro applied to a path', () => {
    describe('When resolving `merge`', () => {
      it('Then the macro unsets merge', () => {
        // Arrange
        const sources = [sourceAt('', '*.bin binary')];

        // Act
        const sut = resolveAttribute(sources, 'a.bin', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given a macro followed by an explicit override on one line', () => {
    describe('When resolving the overridden attribute', () => {
      it('Then the trailing explicit token wins', () => {
        // Arrange
        const sources = [sourceAt('', '*.bin binary merge=custom')];

        // Act
        const sut = resolveAttribute(sources, 'a.bin', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toEqual({ set: 'custom' });
      });
    });
  });

  describe('Given an explicit value preceding a macro on one line', () => {
    describe('When resolving the attribute the macro unsets', () => {
      it('Then the trailing macro wins', () => {
        // Arrange
        const sources = [sourceAt('', '*.bin merge=custom binary')];

        // Act
        const sut = resolveAttribute(sources, 'a.bin', 'merge', BUILTIN_MACROS);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('expandAttributes', () => {
  describe('Given a rule that sets a macro name', () => {
    describe('When expanded', () => {
      it('Then the macro attributes are merged in', () => {
        // Arrange
        const { rules } = parseGitattributes('*.bin binary');

        // Act
        const sut = expandAttributes(rules[0]!.attributes, BUILTIN_MACROS);

        // Assert
        expect(sut.get('merge')).toBe(false);
        expect(sut.get('diff')).toBe(false);
        expect(sut.get('text')).toBe(false);
        expect(sut.get('binary')).toBe(true);
      });
    });
  });

  describe('Given a rule with no macro names', () => {
    describe('When expanded', () => {
      it('Then the attributes pass through unchanged', () => {
        // Arrange
        const { rules } = parseGitattributes('*.txt merge=custom');

        // Act
        const sut = expandAttributes(rules[0]!.attributes, BUILTIN_MACROS);

        // Assert
        expect([...sut]).toEqual([['merge', { set: 'custom' }]]);
      });
    });
  });

  describe('Given a rule that unsets a macro name (`-binary`)', () => {
    describe('When expanded', () => {
      it('Then the macro is NOT expanded (only set names expand)', () => {
        // Arrange
        const { rules } = parseGitattributes('*.x -binary');

        // Act
        const sut = expandAttributes(rules[0]!.attributes, BUILTIN_MACROS);

        // Assert — `-binary` unsets the macro attribute without expanding it.
        expect(sut.get('binary')).toBe(false);
        expect(sut.get('merge')).toBeUndefined();
      });
    });
  });
});

describe('buildMacroRegistry', () => {
  describe('Given user macro definitions', () => {
    describe('When built on top of the built-ins', () => {
      it('Then both built-in and user macros resolve', () => {
        // Arrange
        const { macros } = parseGitattributes('[attr]docs merge=union diff');

        // Act
        const sut = buildMacroRegistry(macros);

        // Assert
        expect(sut.get('binary')?.get('merge')).toBe(false);
        expect(sut.get('docs')?.get('merge')).toEqual({ set: 'union' });
      });
    });

    describe('When a user macro shadows a built-in name', () => {
      it('Then the user definition wins', () => {
        // Arrange
        const { macros } = parseGitattributes('[attr]binary merge=keep');

        // Act
        const sut = buildMacroRegistry(macros);

        // Assert
        expect(sut.get('binary')?.get('merge')).toEqual({ set: 'keep' });
      });
    });
  });
});
