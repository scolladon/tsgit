import { describe, expect, it } from 'vitest';

import {
  narrowSep,
  nativePolicy,
  normalizeForCompareWithCapabilities,
  posixPolicy,
  rootOfForSyntax,
  selectNativePolicy,
  windowsPolicy,
} from '../../../../src/adapters/node/path-policy.js';

describe('selectNativePolicy', () => {
  describe('Given a platform', () => {
    describe('When selectNativePolicy is called', () => {
      it.each([
        {
          platform: 'win32' as const,
          expected: windowsPolicy,
          label: '"win32" returns windowsPolicy',
        },
        {
          platform: 'darwin' as const,
          expected: posixPolicy,
          label: '"darwin" returns posixPolicy',
        },
        { platform: 'linux' as const, expected: posixPolicy, label: '"linux" returns posixPolicy' },
        {
          // `freebsd` is a valid `NodeJS.Platform` member, so no cast is needed. This row
          // guards the default arm of the ternary against a ConditionalExpression mutant
          // that would flip the fallback to windowsPolicy.
          platform: 'freebsd' as const,
          expected: posixPolicy,
          label: 'any other platform falls back to posixPolicy',
        },
      ])('Then $label', ({ platform, expected }) => {
        // Arrange & Act
        const result = selectNativePolicy(platform);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('narrowSep', () => {
  describe('Given the POSIX separator', () => {
    describe('When narrowed', () => {
      it('Then returns it unchanged', () => {
        // Arrange
        const separator = '/';

        // Act
        const result = narrowSep(separator);

        // Assert
        expect(result).toBe('/');
      });
    });
  });

  describe('Given the Windows separator', () => {
    describe('When narrowed', () => {
      it('Then returns it unchanged', () => {
        // Arrange
        const separator = '\\';

        // Act
        const result = narrowSep(separator);

        // Assert
        expect(result).toBe('\\');
      });
    });
  });

  describe('Given an unsupported separator', () => {
    describe('When narrowed', () => {
      it('Then throws with the offending value quoted', () => {
        // Arrange & Act
        let caught: unknown;
        try {
          narrowSep(':');
        } catch (err) {
          caught = err;
        }

        // Assert — the throw arm must fire for any non-`/`-non-`\\` input.
        // Pins the guard against StringLiteral / ConditionalExpression mutants
        // that would weaken or remove either side of the test.
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe('PathPolicy: unsupported separator ":"');
      });
    });
  });

  describe('Given the empty string', () => {
    describe('When narrowed', () => {
      it('Then throws (defensive against a future API regression)', () => {
        // Arrange & Act
        let caught: unknown;
        try {
          narrowSep('');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe('PathPolicy: unsupported separator ""');
      });
    });
  });
});

describe('nativePolicy', () => {
  describe('Given the host platform', () => {
    describe('When nativePolicy is inspected', () => {
      it('Then it matches selectNativePolicy(process.platform)', () => {
        // Arrange & Act
        const result = nativePolicy;

        // Assert
        expect(result).toBe(selectNativePolicy(process.platform));
      });
    });
  });
});

describe('posixPolicy', () => {
  describe('Given posix policy', () => {
    describe('When sep is read', () => {
      it('Then it is forward slash', () => {
        // Arrange & Act
        const result = posixPolicy.sep;

        // Assert
        expect(result).toBe('/');
      });
    });
    describe('When caseInsensitive is read', () => {
      it('Then it is false', () => {
        // Arrange & Act
        const result = posixPolicy.caseInsensitive;

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given mixed-case input', () => {
    describe('When normalizeForCompare runs', () => {
      it('Then identity is returned', () => {
        // Arrange
        const input = '/Users/Foo';

        // Act
        const result = posixPolicy.normalizeForCompare(input);

        // Assert
        expect(result).toBe(input);
      });
    });
  });

  describe('Given an input shaped like a Windows extended-length path', () => {
    describe('When normalizeForCompare runs', () => {
      it('Then it is returned verbatim (POSIX never strips)', () => {
        // Arrange
        const input = '\\\\?\\C:\\X';

        // Act
        const result = posixPolicy.normalizeForCompare(input);

        // Assert — Pins the `caseInsensitive` guard: a ConditionalExpression mutant that
        // routed POSIX through the strip would mangle this otherwise-opaque input.
        expect(result).toBe(input);
      });
    });
  });

  describe('Given an absolute POSIX path', () => {
    describe('When rootOf is called', () => {
      it('Then returns "/"', () => {
        // Arrange
        const path = '/foo/bar';

        // Act
        const result = posixPolicy.rootOf(path);

        // Assert
        expect(result).toBe('/');
      });
    });
  });

  describe('Given a relative POSIX path', () => {
    describe('When rootOf is called', () => {
      it('Then returns the empty string', () => {
        // Arrange
        const path = 'foo/bar';

        // Act
        const result = posixPolicy.rootOf(path);

        // Assert
        expect(result).toBe('');
      });
    });
  });
});

describe('windowsPolicy', () => {
  describe('Given windows policy', () => {
    describe('When sep is read', () => {
      it('Then it is backslash', () => {
        // Arrange & Act
        const result = windowsPolicy.sep;

        // Assert
        expect(result).toBe('\\');
      });
    });
    describe('When caseInsensitive is read', () => {
      it('Then it is true', () => {
        // Arrange & Act
        const result = windowsPolicy.caseInsensitive;

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a Windows path shape', () => {
    describe('When normalizeForCompare runs', () => {
      it.each([
        {
          input: 'C:\\Users\\Foo',
          expected: 'c:\\users\\foo',
          label: 'mixed-case input is lowercased',
        },
        {
          // Guards the `return p` fall-through arm of stripWinExtendedPrefix.
          input: 'D:\\proj\\src',
          expected: 'd:\\proj\\src',
          label: 'a drive path with no extended-length prefix has no characters stripped',
        },
        {
          input: '\\\\?\\C:\\Users\\Foo',
          expected: 'c:\\users\\foo',
          label: 'a \\\\?\\ extended-length drive path has its prefix stripped before case-folding',
        },
        {
          input: '\\\\?\\UNC\\Server\\Share\\file.bin',
          expected: '\\\\server\\share\\file.bin',
          label: 'a \\\\?\\UNC\\ extended-length path collapses to the plain UNC form',
        },
        {
          // A `joinPath`-produced path carries `/` unconditionally even on
          // Windows; the containment prefix compare must fold it to `\` too.
          input: 'C:\\repo/sub/file.bin',
          expected: 'c:\\repo\\sub\\file.bin',
          label: 'a forward-slash-separated tail is folded to backslashes',
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange & Act
        const result = windowsPolicy.normalizeForCompare(input);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a Windows drive-letter path', () => {
    describe('When rootOf is called', () => {
      it('Then returns the drive prefix with trailing separator', () => {
        // Arrange
        const path = 'C:\\Users\\Foo';

        // Act
        const result = windowsPolicy.rootOf(path);

        // Assert
        expect(result).toBe('C:\\');
      });
    });
  });

  describe('Given a UNC path', () => {
    describe('When rootOf is called', () => {
      it('Then returns the server+share prefix', () => {
        // Arrange
        const path = '\\\\server\\share\\file.bin';

        // Act
        const result = windowsPolicy.rootOf(path);

        // Assert
        expect(result).toBe('\\\\server\\share\\');
      });
    });
  });

  describe('Given a drive-relative Windows path (neither UNC nor drive-absolute)', () => {
    describe('When rootOf is called', () => {
      it('Then returns the empty string', () => {
        // Arrange
        const path = 'Users\\Foo';

        // Act
        const result = windowsPolicy.rootOf(path);

        // Assert
        expect(result).toBe('');
      });
    });
  });
});

describe('policy capability triples', () => {
  describe('Given posixPolicy', () => {
    describe('When its capability flags are read', () => {
      it('Then caseInsensitive/windowsSyntax are false and honoursNoFollow is true', () => {
        // Arrange & Act
        const result = {
          caseInsensitive: posixPolicy.caseInsensitive,
          windowsSyntax: posixPolicy.windowsSyntax,
          honoursNoFollow: posixPolicy.honoursNoFollow,
        };

        // Assert
        expect(result).toStrictEqual({
          caseInsensitive: false,
          windowsSyntax: false,
          honoursNoFollow: true,
        });
      });
    });
  });

  describe('Given windowsPolicy', () => {
    describe('When its capability flags are read', () => {
      it('Then caseInsensitive/windowsSyntax are true and honoursNoFollow is false', () => {
        // Arrange & Act
        const result = {
          caseInsensitive: windowsPolicy.caseInsensitive,
          windowsSyntax: windowsPolicy.windowsSyntax,
          honoursNoFollow: windowsPolicy.honoursNoFollow,
        };

        // Assert
        expect(result).toStrictEqual({
          caseInsensitive: true,
          windowsSyntax: true,
          honoursNoFollow: false,
        });
      });
    });
  });
});

describe('a hypothetical case-insensitive POSIX policy (caseInsensitive=true, windowsSyntax=false)', () => {
  // Pins the exact latent break the capability split prevents: before it,
  // both `rootOf` and `normalizeForCompare` were gated on the single
  // `caseInsensitive` flag, so a case-insensitive POSIX policy would have
  // been routed through Windows root parsing and the `/`→`\` separator
  // fold, mangling every POSIX path. Keying both on `windowsSyntax`
  // (false here) instead proves POSIX behaviour survives independently of
  // case sensitivity.
  const hypotheticalCapabilities = { caseInsensitive: true, windowsSyntax: false };

  describe('Given an absolute POSIX path', () => {
    describe('When rootOf is computed for the hypothetical capabilities', () => {
      it('Then it still returns the POSIX root, not a Windows one', () => {
        // Arrange
        const path = '/foo/bar';

        // Act
        const result = rootOfForSyntax(hypotheticalCapabilities.windowsSyntax, path);

        // Assert
        expect(result).toBe('/');
      });
    });
  });

  describe('Given a POSIX path containing a forward slash', () => {
    describe('When normalizeForCompare is computed for the hypothetical capabilities', () => {
      it('Then the separator is left as "/" (no Windows fold) but the case is still folded', () => {
        // Arrange
        const path = '/Foo/Bar';

        // Act
        const result = normalizeForCompareWithCapabilities(hypotheticalCapabilities, path);

        // Assert — case-folded (caseInsensitive: true) but the separator
        // survives untouched (windowsSyntax: false); a pre-split policy
        // would have folded it to "\\foo\\bar" instead.
        expect(result).toBe('/foo/bar');
      });
    });
  });
});
