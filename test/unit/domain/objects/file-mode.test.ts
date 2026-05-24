import { describe, expect, it } from 'vitest';

import {
  isDirectory,
  normalizeFileMode,
  validateFileMode,
} from '../../../../src/domain/objects/file-mode.js';

describe('file-mode', () => {
  describe('validateFileMode', () => {
    it("Given '100644', When validating, Then returns '100644' (REGULAR)", () => {
      // Arrange & Act
      const sut = validateFileMode('100644');

      // Assert
      expect(sut).toBe('100644');
    });

    it("Given '100755', When validating, Then returns '100755' (EXECUTABLE)", () => {
      // Arrange & Act
      const sut = validateFileMode('100755');

      // Assert
      expect(sut).toBe('100755');
    });

    it("Given '120000', When validating, Then returns '120000' (SYMLINK)", () => {
      // Arrange & Act
      const sut = validateFileMode('120000');

      // Assert
      expect(sut).toBe('120000');
    });

    it("Given '40000', When validating, Then returns '40000' (DIRECTORY)", () => {
      // Arrange & Act
      const sut = validateFileMode('40000');

      // Assert
      expect(sut).toBe('40000');
    });

    it("Given '160000', When validating, Then returns '160000' (GITLINK)", () => {
      // Arrange & Act
      const sut = validateFileMode('160000');

      // Assert
      expect(sut).toBe('160000');
    });

    it("Given '999999', When validating, Then throws INVALID_FILE_MODE", () => {
      // Arrange & Act & Assert
      // Assert
      expect(() => validateFileMode('999999')).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'INVALID_FILE_MODE' }),
        }),
      );
    });

    it("Given '', When validating, Then throws INVALID_FILE_MODE", () => {
      // Arrange & Act & Assert
      // Assert
      expect(() => validateFileMode('')).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'INVALID_FILE_MODE' }),
        }),
      );
    });
  });

  describe('normalizeFileMode', () => {
    it("Given '040000', When normalizing, Then returns '40000'", () => {
      // Arrange & Act
      const sut = normalizeFileMode('040000');

      // Assert
      expect(sut).toBe('40000');
    });

    it("Given '100644', When normalizing, Then returns '100644' (already normalized, idempotent)", () => {
      // Arrange & Act
      const sut = normalizeFileMode('100644');

      // Assert
      expect(sut).toBe('100644');
    });

    it("Given '40000', When normalizing, Then returns '40000' (already normalized, idempotent)", () => {
      // Arrange & Act
      const sut = normalizeFileMode('40000');

      // Assert
      expect(sut).toBe('40000');
    });

    it("Given '999999', When normalizing, Then throws INVALID_FILE_MODE", () => {
      // Arrange & Act & Assert
      // Assert
      expect(() => normalizeFileMode('999999')).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'INVALID_FILE_MODE' }),
        }),
      );
    });
  });

  describe('isDirectory', () => {
    it("Given '40000', When checking isDirectory, Then returns true", () => {
      // Arrange & Act
      const sut = isDirectory('40000');

      // Assert
      expect(sut).toBe(true);
    });

    it("Given '100644', When checking isDirectory, Then returns false", () => {
      // Arrange & Act
      const sut = isDirectory('100644');

      // Assert
      expect(sut).toBe(false);
    });

    it("Given '100755', When checking isDirectory, Then returns false", () => {
      // Arrange & Act
      const sut = isDirectory('100755');

      // Assert
      expect(sut).toBe(false);
    });
  });
});
