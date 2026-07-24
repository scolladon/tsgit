import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/objects/error.js';
import {
  deriveWorkingMode,
  type FileMode,
  isDirectory,
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
          const sut = validateFileMode(mode);

          // Assert
          expect(sut).toBe(mode);
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
          const sut = normalizeFileMode(input);

          // Assert
          expect(sut).toBe(expected);
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
          const sut = isDirectory(mode);

          // Assert
          expect(sut).toBe(expected);
        });
      });
    });
  });

  describe('deriveWorkingMode', () => {
    describe('Given a symbolic link (even with executable bits set)', () => {
      describe('When deriving the working mode', () => {
        it("Then returns '120000' (SYMLINK), the link check taking precedence", () => {
          // Arrange & Act
          const sut = deriveWorkingMode({ isSymbolicLink: true, mode: 0o777 });

          // Assert
          expect(sut).toBe('120000');
        });
      });
    });

    describe('Given a regular file with an owner-execute bit', () => {
      describe('When deriving the working mode', () => {
        it("Then returns '100755' (EXECUTABLE)", () => {
          // Arrange & Act
          const sut = deriveWorkingMode({ isSymbolicLink: false, mode: 0o744 });

          // Assert
          expect(sut).toBe('100755');
        });
      });
    });

    describe('Given a regular file with a group/other-only execute bit', () => {
      describe('When deriving the working mode', () => {
        it("Then returns '100755' (any of the 0o111 bits counts)", () => {
          // Arrange & Act
          const sut = deriveWorkingMode({ isSymbolicLink: false, mode: 0o641 });

          // Assert
          expect(sut).toBe('100755');
        });
      });
    });

    describe('Given a regular file with no execute bits', () => {
      describe('When deriving the working mode', () => {
        it("Then returns '100644' (REGULAR)", () => {
          // Arrange & Act
          const sut = deriveWorkingMode({ isSymbolicLink: false, mode: 0o644 });

          // Assert
          expect(sut).toBe('100644');
        });
      });
    });
  });
});
