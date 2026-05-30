import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/objects/error.js';
import {
  deriveWorkingMode,
  isDirectory,
  normalizeFileMode,
  validateFileMode,
} from '../../../../src/domain/objects/file-mode.js';

describe('file-mode', () => {
  describe('validateFileMode', () => {
    describe("Given '100644'", () => {
      describe('When validating', () => {
        it("Then returns '100644' (REGULAR)", () => {
          // Arrange & Act
          const sut = validateFileMode('100644');

          // Assert
          expect(sut).toBe('100644');
        });
      });
    });

    describe("Given '100755'", () => {
      describe('When validating', () => {
        it("Then returns '100755' (EXECUTABLE)", () => {
          // Arrange & Act
          const sut = validateFileMode('100755');

          // Assert
          expect(sut).toBe('100755');
        });
      });
    });

    describe("Given '120000'", () => {
      describe('When validating', () => {
        it("Then returns '120000' (SYMLINK)", () => {
          // Arrange & Act
          const sut = validateFileMode('120000');

          // Assert
          expect(sut).toBe('120000');
        });
      });
    });

    describe("Given '40000'", () => {
      describe('When validating', () => {
        it("Then returns '40000' (DIRECTORY)", () => {
          // Arrange & Act
          const sut = validateFileMode('40000');

          // Assert
          expect(sut).toBe('40000');
        });
      });
    });

    describe("Given '160000'", () => {
      describe('When validating', () => {
        it("Then returns '160000' (GITLINK)", () => {
          // Arrange & Act
          const sut = validateFileMode('160000');

          // Assert
          expect(sut).toBe('160000');
        });
      });
    });

    describe("Given '999999'", () => {
      describe('When validating', () => {
        it('Then throws INVALID_FILE_MODE with the invalid value', () => {
          // Arrange
          let caught: unknown;

          // Act
          try {
            validateFileMode('999999');
          } catch (error) {
            caught = error;
          }

          // Assert — both `code` and `value` are pinned to kill nested-property mutants.
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_FILE_MODE',
            value: '999999',
          });
        });
      });
    });

    describe("Given ''", () => {
      describe('When validating', () => {
        it('Then throws INVALID_FILE_MODE with the invalid value', () => {
          // Arrange
          let caught: unknown;

          // Act
          try {
            validateFileMode('');
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_FILE_MODE',
            value: '',
          });
        });
      });
    });
  });

  describe('normalizeFileMode', () => {
    describe("Given '040000'", () => {
      describe('When normalizing', () => {
        it("Then returns '40000'", () => {
          // Arrange & Act
          const sut = normalizeFileMode('040000');

          // Assert
          expect(sut).toBe('40000');
        });
      });
    });

    describe("Given '100644'", () => {
      describe('When normalizing', () => {
        it("Then returns '100644' (already normalized, idempotent)", () => {
          // Arrange & Act
          const sut = normalizeFileMode('100644');

          // Assert
          expect(sut).toBe('100644');
        });
      });
    });

    describe("Given '40000'", () => {
      describe('When normalizing', () => {
        it("Then returns '40000' (already normalized, idempotent)", () => {
          // Arrange & Act
          const sut = normalizeFileMode('40000');

          // Assert
          expect(sut).toBe('40000');
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
    describe("Given '40000'", () => {
      describe('When checking isDirectory', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const sut = isDirectory('40000');

          // Assert
          expect(sut).toBe(true);
        });
      });
    });

    describe("Given '100644'", () => {
      describe('When checking isDirectory', () => {
        it('Then returns false', () => {
          // Arrange & Act
          const sut = isDirectory('100644');

          // Assert
          expect(sut).toBe(false);
        });
      });
    });

    describe("Given '100755'", () => {
      describe('When checking isDirectory', () => {
        it('Then returns false', () => {
          // Arrange & Act
          const sut = isDirectory('100755');

          // Assert
          expect(sut).toBe(false);
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
