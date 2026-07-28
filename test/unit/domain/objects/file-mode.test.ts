import { describe, expect, it } from 'vitest';

import { encode } from '../../../../src/domain/objects/encoding.js';
import { TsgitError } from '../../../../src/domain/objects/error.js';
import {
  deriveWorkingMode,
  FILE_MODE,
  type FileMode,
  isDirectory,
  matchFileModeBytes,
  normalizeFileMode,
  validateFileMode,
} from '../../../../src/domain/objects/file-mode.js';

describe('file-mode', () => {
  describe('validateFileMode', () => {
    describe('Given a recognized git file mode', () => {
      describe('When validating', () => {
        it.each([
          ['100644', 'REGULAR'],
          ['100755', 'EXECUTABLE'],
          ['120000', 'SYMLINK'],
          ['40000', 'DIRECTORY'],
          ['160000', 'GITLINK'],
        ])("Then returns '%s' (%s)", (mode) => {
          // Arrange & Act
          const result = validateFileMode(mode);

          // Assert
          expect(result).toBe(mode);
        });
      });
    });

    describe('Given an unrecognized file mode', () => {
      describe('When validating', () => {
        it.each(['999999', ''])(
          "Then throws INVALID_FILE_MODE with the invalid value '%s'",
          (value) => {
            // Arrange
            let caught: unknown;

            // Act
            try {
              validateFileMode(value);
            } catch (error) {
              caught = error;
            }

            // Assert — both `code` and `value` are pinned to kill nested-property mutants.
            expect(caught).toBeInstanceOf(TsgitError);
            expect((caught as TsgitError).data).toEqual({
              code: 'INVALID_FILE_MODE',
              value,
            });
          },
        );
      });
    });
  });

  describe('normalizeFileMode', () => {
    describe('Given a file mode with or without a leading-zero prefix', () => {
      describe('When normalizing', () => {
        it.each([
          { input: '040000', expected: '40000', label: "'040000' becomes '40000'" },
          {
            input: '100644',
            expected: '100644',
            label: "'100644' is already normalized, idempotent",
          },
          {
            input: '40000',
            expected: '40000',
            label: "'40000' is already normalized, idempotent",
          },
        ])('Then $label', ({ input, expected }) => {
          // Arrange & Act
          const result = normalizeFileMode(input);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });

    describe("Given '999999'", () => {
      describe('When normalizing', () => {
        it('Then throws INVALID_FILE_MODE with the invalid value', () => {
          // Arrange
          let caught: unknown;

          // Act
          try {
            normalizeFileMode('999999');
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_FILE_MODE',
            value: '999999',
          });
        });
      });
    });
  });

  describe('isDirectory', () => {
    describe('Given a file mode', () => {
      describe('When checking isDirectory', () => {
        it.each<[FileMode, boolean]>([
          ['40000', true],
          ['100644', false],
          ['100755', false],
        ])('Then %s returns %s', (mode, expected) => {
          // Arrange & Act
          const result = isDirectory(mode);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('deriveWorkingMode', () => {
    describe('Given a symbolic link (even with executable bits set)', () => {
      describe('When deriving the working mode', () => {
        it("Then returns '120000' (SYMLINK), the link check taking precedence", () => {
          // Arrange & Act
          const result = deriveWorkingMode({ isSymbolicLink: true, mode: 0o777 });

          // Assert
          expect(result).toBe('120000');
        });
      });
    });

    describe('Given a regular file with an owner-execute bit', () => {
      describe('When deriving the working mode', () => {
        it("Then returns '100755' (EXECUTABLE)", () => {
          // Arrange & Act
          const result = deriveWorkingMode({ isSymbolicLink: false, mode: 0o744 });

          // Assert
          expect(result).toBe('100755');
        });
      });
    });

    describe('Given a regular file with a group/other-only execute bit', () => {
      describe('When deriving the working mode', () => {
        it("Then returns '100755' (any of the 0o111 bits counts)", () => {
          // Arrange & Act
          const result = deriveWorkingMode({ isSymbolicLink: false, mode: 0o641 });

          // Assert
          expect(result).toBe('100755');
        });
      });
    });

    describe('Given a regular file with no execute bits', () => {
      describe('When deriving the working mode', () => {
        it("Then returns '100644' (REGULAR)", () => {
          // Arrange & Act
          const result = deriveWorkingMode({ isSymbolicLink: false, mode: 0o644 });

          // Assert
          expect(result).toBe('100644');
        });
      });
    });
  });

  describe('matchFileModeBytes', () => {
    describe('Given the byte range of a recognized git file mode', () => {
      describe('When matching', () => {
        it.each([
          { mode: '100644', expected: FILE_MODE.REGULAR, label: 'REGULAR' },
          { mode: '100755', expected: FILE_MODE.EXECUTABLE, label: 'EXECUTABLE' },
          { mode: '120000', expected: FILE_MODE.SYMLINK, label: 'SYMLINK' },
          { mode: '40000', expected: FILE_MODE.DIRECTORY, label: 'DIRECTORY' },
          { mode: '160000', expected: FILE_MODE.GITLINK, label: 'GITLINK' },
          { mode: '040000', expected: FILE_MODE.DIRECTORY, label: 'DIRECTORY, zero-prefixed' },
        ])('Then returns the interned $label constant', ({ mode, expected }) => {
          // Arrange
          const buf = encode(mode);
          const sut = matchFileModeBytes;

          // Act
          const result = sut(buf, 0, buf.length);

          // Assert — identity, not just equality: the matcher must return the
          // interned FILE_MODE constant, never a freshly decoded string.
          expect(result).toBe(expected);
        });
      });
    });

    describe('Given the byte range of an unrecognized mode', () => {
      describe('When matching', () => {
        it('Then throws INVALID_FILE_MODE with the decoded value', () => {
          // Arrange
          const buf = encode('100664');
          let caught: unknown;

          // Act
          try {
            matchFileModeBytes(buf, 0, buf.length);
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_FILE_MODE',
            value: '100664',
          });
        });
      });
    });

    describe('Given a byte range that stops just short of a directory mode', () => {
      describe('When matching', () => {
        it.each([
          { mode: '40001', label: "'40001' (length 5, content diverges from '40000')" },
          { mode: '400000', label: "'400000' (length 6, first 5 bytes equal '40000')" },
        ])('Then throws INVALID_FILE_MODE with the decoded value ($label)', ({ mode }) => {
          // Arrange — both rows exercise the same directory-match guard from
          // opposite sides: '40001' is the right operand (same length,
          // diverging content), '400000' is the left operand (matching
          // prefix, wrong length) — neither passes alone.
          const buf = encode(mode);
          let caught: unknown;

          // Act
          try {
            matchFileModeBytes(buf, 0, buf.length);
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_FILE_MODE',
            value: mode,
          });
        });
      });
    });

    describe('Given the byte range of a mode whose length is neither 5 nor 6', () => {
      describe('When matching', () => {
        it('Then throws INVALID_FILE_MODE with the decoded value', () => {
          // Arrange
          const buf = encode('1');
          let caught: unknown;

          // Act
          try {
            matchFileModeBytes(buf, 0, buf.length);
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_FILE_MODE',
            value: '1',
          });
        });
      });
    });

    describe('Given an invalid mode exactly at the 16-byte truncation boundary', () => {
      describe('When matching', () => {
        it('Then the error carries the exact 16-byte value, untruncated', () => {
          // Arrange
          const value = '9'.repeat(16);
          const buf = encode(value);
          let caught: unknown;

          // Act
          try {
            matchFileModeBytes(buf, 0, buf.length);
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_FILE_MODE',
            value,
          });
        });
      });
    });

    describe('Given an invalid mode exceeding the 16-byte truncation boundary', () => {
      describe('When matching', () => {
        it('Then the error carries only the first 16 bytes plus an ellipsis marker', () => {
          // Arrange
          const buf = encode('9'.repeat(1_000_000));
          let caught: unknown;

          // Act
          try {
            matchFileModeBytes(buf, 0, buf.length);
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_FILE_MODE',
            value: `${'9'.repeat(16)}…`,
          });
        });
      });
    });

    describe('Given a byte range embedded inside a larger buffer', () => {
      describe('When matching only that slice', () => {
        it('Then matches on the [start, end) window, ignoring surrounding bytes', () => {
          // Arrange
          const buf = encode('xx100644yy');
          const sut = matchFileModeBytes;

          // Act
          const result = sut(buf, 2, 8);

          // Assert
          expect(result).toBe(FILE_MODE.REGULAR);
        });
      });
    });
  });
});
