import { describe, expect, it } from 'vitest';

import {
  narrowSep,
  nativePolicy,
  posixPolicy,
  selectNativePolicy,
  windowsPolicy,
} from '../../../../src/adapters/node/path-policy.js';

describe('selectNativePolicy', () => {
  describe('Given platform = "win32"', () => {
    describe('When selectNativePolicy is called', () => {
      it('Then returns windowsPolicy', () => {
        // Arrange & Act
        const sut = selectNativePolicy('win32');

        // Assert
        expect(sut).toBe(windowsPolicy);
      });
    });
  });

  describe('Given platform = "darwin"', () => {
    describe('When selectNativePolicy is called', () => {
      it('Then returns posixPolicy', () => {
        // Arrange & Act
        const sut = selectNativePolicy('darwin');

        // Assert
        expect(sut).toBe(posixPolicy);
      });
    });
  });

  describe('Given platform = "linux"', () => {
    describe('When selectNativePolicy is called', () => {
      it('Then returns posixPolicy', () => {
        // Arrange & Act
        const sut = selectNativePolicy('linux');

        // Assert
        expect(sut).toBe(posixPolicy);
      });
    });
  });

  describe('Given a non-win32 platform', () => {
    describe('When selectNativePolicy is called', () => {
      it('Then it falls back to posixPolicy', () => {
        // Arrange & Act — guards the default arm of the ternary against a
        // ConditionalExpression mutant that would flip the fallback to
        // windowsPolicy. Any non-"win32" platform must yield posixPolicy.
        // `freebsd` is a valid `NodeJS.Platform` member, so no cast is needed.
        const sut = selectNativePolicy('freebsd');

        // Assert
        expect(sut).toBe(posixPolicy);
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

  describe('Given mixed-case input', () => {
    describe('When normalizeForCompare runs', () => {
      it('Then returns lowercased string', () => {
        // Arrange
        const sut = windowsPolicy.normalizeForCompare('C:\\Users\\Foo');

        // Assert
        expect(sut).toBe('c:\\users\\foo');
      });
    });
  });

  describe('Given a drive path with no extended-length prefix', () => {
    describe('When normalizeForCompare runs', () => {
      it('Then no characters are stripped', () => {
        // Arrange + Assert
        // Guards the `return p` fall-through arm of stripWinExtendedPrefix.
        expect(windowsPolicy.normalizeForCompare('D:\\proj\\src')).toBe('d:\\proj\\src');
      });
    });
  });

  describe('Given a \\\\\\\\?\\\\ extended-length drive path', () => {
    describe('When normalizeForCompare runs', () => {
      it('Then the prefix is stripped before case-folding', () => {
        // Arrange
        const sut = windowsPolicy.normalizeForCompare('\\\\?\\C:\\Users\\Foo');

        // Assert
        expect(sut).toBe('c:\\users\\foo');
      });
    });
  });

  describe('Given a \\\\\\\\?\\\\UNC\\\\ extended-length path', () => {
    describe('When normalizeForCompare runs', () => {
      it('Then it collapses to the plain UNC form', () => {
        // Arrange + Assert
        expect(windowsPolicy.normalizeForCompare('\\\\?\\UNC\\Server\\Share\\file.bin')).toBe(
          '\\\\server\\share\\file.bin',
        );
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
