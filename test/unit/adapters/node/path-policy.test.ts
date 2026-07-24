import { describe, expect, it } from 'vitest';

import {
  narrowSep,
  nativePolicy,
  posixPolicy,
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
        const sut = selectNativePolicy(platform);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});

describe('narrowSep', () => {
  describe('Given the POSIX separator', () => {
    describe('When narrowed', () => {
      it('Then returns it unchanged', () => {
        // Arrange
        const sut = narrowSep('/');

        // Assert
        expect(sut).toBe('/');
      });
    });
  });

  describe('Given the Windows separator', () => {
    describe('When narrowed', () => {
      it('Then returns it unchanged', () => {
        // Arrange
        const sut = narrowSep('\\');

        // Assert
        expect(sut).toBe('\\');
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
        // Arrange
        const sut = nativePolicy;

        // Assert
        expect(sut).toBe(selectNativePolicy(process.platform));
      });
    });
  });
});

describe('posixPolicy', () => {
  describe('Given posix policy', () => {
    describe('When sep is read', () => {
      it('Then it is forward slash', () => {
        // Arrange
        const sut = posixPolicy.sep;

        // Assert
        expect(sut).toBe('/');
      });
    });
    describe('When caseInsensitive is read', () => {
      it('Then it is false', () => {
        // Arrange
        const sut = posixPolicy.caseInsensitive;

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given mixed-case input', () => {
    describe('When normalizeForCompare runs', () => {
      it('Then identity is returned', () => {
        // Arrange
        const sut = posixPolicy.normalizeForCompare('/Users/Foo');

        // Assert
        expect(sut).toBe('/Users/Foo');
      });
    });
  });

  describe('Given an input shaped like a Windows extended-length path', () => {
    describe('When normalizeForCompare runs', () => {
      it('Then it is returned verbatim (POSIX never strips)', () => {
        // Arrange + Assert
        // Pins the `caseInsensitive` guard: a ConditionalExpression mutant that
        // routed POSIX through the strip would mangle this otherwise-opaque input.
        expect(posixPolicy.normalizeForCompare('\\\\?\\C:\\X')).toBe('\\\\?\\C:\\X');
      });
    });
  });

  describe('Given an absolute POSIX path', () => {
    describe('When rootOf is called', () => {
      it('Then returns "/"', () => {
        // Arrange
        const sut = posixPolicy.rootOf('/foo/bar');

        // Assert
        expect(sut).toBe('/');
      });
    });
  });
});

describe('windowsPolicy', () => {
  describe('Given windows policy', () => {
    describe('When sep is read', () => {
      it('Then it is backslash', () => {
        // Arrange
        const sut = windowsPolicy.sep;

        // Assert
        expect(sut).toBe('\\');
      });
    });
    describe('When caseInsensitive is read', () => {
      it('Then it is true', () => {
        // Arrange
        const sut = windowsPolicy.caseInsensitive;

        // Assert
        expect(sut).toBe(true);
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
      ])('Then $label', ({ input, expected }) => {
        // Arrange
        const sut = windowsPolicy.normalizeForCompare(input);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });

  describe('Given a Windows drive-letter path', () => {
    describe('When rootOf is called', () => {
      it('Then returns the drive prefix with trailing separator', () => {
        // Arrange
        const sut = windowsPolicy.rootOf('C:\\Users\\Foo');

        // Assert
        expect(sut).toBe('C:\\');
      });
    });
  });

  describe('Given a UNC path', () => {
    describe('When rootOf is called', () => {
      it('Then returns the server+share prefix', () => {
        // Arrange
        const sut = windowsPolicy.rootOf('\\\\server\\share\\file.bin');

        // Assert
        expect(sut).toBe('\\\\server\\share\\');
      });
    });
  });
});
