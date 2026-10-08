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

/** The same source, with every path its rules' matchers are asked about appended to `seen`. */
const recordingMatches = (source: AttributeSource, seen: string[]): AttributeSource => ({
  ...source,
  rules: source.rules.map((rule) => ({
    ...rule,
    compiled: {
      test: (path: string) => {
        seen.push(path);
        return rule.compiled.test(path);
      },
    },
  })),
});

describe('resolveAttribute', () => {
  describe('Given no sources', () => {
    describe('When resolving any attribute', () => {
      it("Then yields 'unspecified'", () => {
        // Arrange
        const sources: ReadonlyArray<AttributeSource> = [];

        // Act
        const result = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toBe('unspecified');
      });
    });
  });

  describe('Given a directory-only pattern `foo/ text`', () => {
    describe('When resolving a path', () => {
      it.each<{ label: string; path: string; expected: unknown }>([
        { label: 'a file named foo', path: 'foo', expected: 'unspecified' },
        { label: 'the directory foo/', path: 'foo/', expected: true },
        { label: 'a nested directory x/foo/', path: 'x/foo/', expected: true },
        { label: 'a file x/foo', path: 'x/foo', expected: 'unspecified' },
      ])('Then $label yields $expected', ({ path, expected }) => {
        // Arrange
        const sources = [sourceAt('', 'foo/ text')];

        // Act
        const result = resolveAttribute(sources, path, 'text', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a single matching set rule', () => {
    describe('When resolving the attribute', () => {
      it('Then yields the set value', () => {
        // Arrange
        const sources = [sourceAt('', '*.txt merge=custom')];

        // Act
        const result = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual({ set: 'custom' });
      });
    });
  });

  describe('Given a non-matching rule', () => {
    describe('When resolving the attribute', () => {
      it("Then yields 'unspecified'", () => {
        // Arrange
        const sources = [sourceAt('', '*.bin merge=custom')];

        // Act
        const result = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toBe('unspecified');
      });
    });
  });

  describe('Given two matching rules in one source', () => {
    describe('When resolving the attribute', () => {
      it('Then the last match wins', () => {
        // Arrange
        const sources = [sourceAt('', '*.txt merge=first\na.txt -merge')];

        // Act
        const result = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given two sources both assigning the attribute', () => {
    describe('When resolving', () => {
      it('Then the higher-precedence (earlier) source wins', () => {
        // Arrange
        const sources = [sourceAt('', '*.txt merge=high'), sourceAt('', '*.txt merge=low')];

        // Act
        const result = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual({ set: 'high' });
      });
    });
  });

  describe('Given a higher source that does not assign the attribute', () => {
    describe('When resolving', () => {
      it('Then the lower source supplies the value', () => {
        // Arrange
        const sources = [sourceAt('', '*.txt text'), sourceAt('', '*.txt merge=low')];

        // Act
        const result = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual({ set: 'low' });
      });
    });
  });

  describe('Given an explicit unspecified (`!merge`) in the higher source', () => {
    describe('When resolving', () => {
      it("Then yields 'unspecified' and shadows lower sources", () => {
        // Arrange
        const sources = [sourceAt('', '*.txt !merge'), sourceAt('', '*.txt merge=low')];

        // Act
        const result = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toBe('unspecified');
      });
    });
  });

  describe('Given a source rooted in a subdirectory', () => {
    describe('When the path lies under that basedir', () => {
      it('Then the pattern matches relative to the basedir', () => {
        // Arrange
        const sources = [sourceAt('a/b', '*.txt merge=sub')];

        // Act
        const result = resolveAttribute(sources, 'a/b/c.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual({ set: 'sub' });
      });
    });

    describe('When an anchored pattern meets a path outside that basedir', () => {
      it.each([
        { label: 'in its parent', path: 'a/x.txt' },
        { label: 'in a sibling sharing its name as a prefix', path: 'a/bcx.txt' },
        { label: 'in a sibling as long as it', path: 'a/c/x.txt' },
      ])('Then the rule is skipped for a path $label', ({ path }) => {
        // Arrange
        const sources = [sourceAt('a/b', '/x.txt merge=sub')];
        const sut = resolveAttribute;

        // Act
        const result = sut(sources, path, 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toBe('unspecified');
      });
    });

    describe('When an anchored pattern only matches the basedir-relative path', () => {
      it('Then the match is against the stripped path, not the full path', () => {
        // Arrange — `x/c.txt` is anchored (interior slash); it must be matched
        // against `x/c.txt` (relative to `a/b`), never `a/b/x/c.txt`.
        const sources = [sourceAt('a/b', 'x/c.txt merge=anchored')];

        // Act
        const result = resolveAttribute(sources, 'a/b/x/c.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual({ set: 'anchored' });
      });
    });
  });

  describe('Given a pattern with no slash', () => {
    describe('When resolving a path several directories deep', () => {
      it('Then its matcher sees only the basename, never the directories above it', () => {
        // Arrange
        const seen: string[] = [];
        const sources = [recordingMatches(sourceAt('a', '*.txt merge=deep'), seen)];
        const sut = resolveAttribute;

        // Act
        const result = sut(sources, 'a/b/c/d/e.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual({ set: 'deep' });
        expect(seen).toEqual(['e.txt']);
      });
    });

    describe('When its source sits deep above the path', () => {
      it("Then the source's directory is never compared against the path", () => {
        // Arrange
        let basedirReads = 0;
        const { rules } = sourceAt('', '*.txt merge=deep');
        const source: AttributeSource = {
          rules,
          get basedir() {
            basedirReads += 1;
            return 'a/b/c';
          },
        };
        const sut = resolveAttribute;

        // Act
        const result = sut([source], 'a/b/c/d/e.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual({ set: 'deep' });
        expect(basedirReads).toBe(0);
      });
    });

    describe('When its `**` would only match across a directory boundary', () => {
      it.each<{ label: string; path: string; expected: unknown }>([
        { label: 'a basename it spans', path: 'x/ab', expected: true },
        {
          label: 'a path whose basename it does not span',
          path: 'q/a/xb',
          expected: 'unspecified',
        },
      ])('Then $label yields $expected', ({ path, expected }) => {
        // Arrange
        const sources = [sourceAt('', 'a**b foo')];
        const sut = resolveAttribute;

        // Act
        const result = sut(sources, path, 'foo', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a later matching rule that does not assign the attribute', () => {
    describe('When resolving', () => {
      it('Then the earlier assignment is retained (the non-assigning match is ignored)', () => {
        // Arrange — rule 1 sets merge; rule 2 also matches but only sets `text`.
        const sources = [sourceAt('', '* merge=keep\n* text')];

        // Act
        const result = resolveAttribute(sources, 'a.txt', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual({ set: 'keep' });
      });
    });
  });

  describe('Given the built-in `binary` macro applied to a path', () => {
    describe('When resolving `merge`', () => {
      it('Then the macro unsets merge', () => {
        // Arrange
        const sources = [sourceAt('', '*.bin binary')];

        // Act
        const result = resolveAttribute(sources, 'a.bin', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a macro followed by an explicit override on one line', () => {
    describe('When resolving the overridden attribute', () => {
      it('Then the trailing explicit token wins', () => {
        // Arrange
        const sources = [sourceAt('', '*.bin binary merge=custom')];

        // Act
        const result = resolveAttribute(sources, 'a.bin', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toEqual({ set: 'custom' });
      });
    });
  });

  describe('Given an explicit value preceding a macro on one line', () => {
    describe('When resolving the attribute the macro unsets', () => {
      it('Then the trailing macro wins', () => {
        // Arrange
        const sources = [sourceAt('', '*.bin merge=custom binary')];

        // Act
        const result = resolveAttribute(sources, 'a.bin', 'merge', BUILTIN_MACROS);

        // Assert
        expect(result).toBe(false);
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
        const result = expandAttributes(rules[0]!.attributes, BUILTIN_MACROS);

        // Assert
        expect(result.get('merge')).toBe(false);
        expect(result.get('diff')).toBe(false);
        expect(result.get('text')).toBe(false);
        expect(result.get('binary')).toBe(true);
      });
    });
  });

  describe('Given a rule with no macro names', () => {
    describe('When expanded', () => {
      it('Then the attributes pass through unchanged', () => {
        // Arrange
        const { rules } = parseGitattributes('*.txt merge=custom');

        // Act
        const result = expandAttributes(rules[0]!.attributes, BUILTIN_MACROS);

        // Assert
        expect([...result]).toEqual([['merge', { set: 'custom' }]]);
      });
    });
  });

  describe('Given a rule that unsets a macro name (`-binary`)', () => {
    describe('When expanded', () => {
      it('Then the macro is NOT expanded (only set names expand)', () => {
        // Arrange
        const { rules } = parseGitattributes('*.x -binary');

        // Act
        const result = expandAttributes(rules[0]!.attributes, BUILTIN_MACROS);

        // Assert — `-binary` unsets the macro attribute without expanding it.
        expect(result.get('binary')).toBe(false);
        expect(result.get('merge')).toBeUndefined();
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
        const result = buildMacroRegistry(macros);

        // Assert
        expect(result.get('binary')?.get('merge')).toBe(false);
        expect(result.get('docs')?.get('merge')).toEqual({ set: 'union' });
      });
    });

    describe('When a user macro shadows a built-in name', () => {
      it('Then the user definition wins', () => {
        // Arrange
        const { macros } = parseGitattributes('[attr]binary merge=keep');

        // Act
        const result = buildMacroRegistry(macros);

        // Assert
        expect(result.get('binary')?.get('merge')).toEqual({ set: 'keep' });
      });
    });
  });
});
