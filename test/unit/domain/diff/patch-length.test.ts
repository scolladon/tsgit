import { describe, expect, it } from 'vitest';
import {
  assertPatchTextFits,
  MAX_PATCH_TEXT_CHARS,
} from '../../../../src/domain/diff/patch-length.js';
import { TsgitError } from '../../../../src/domain/error.js';

describe('assertPatchTextFits', () => {
  describe('Given a character count exactly at the ceiling, When the length is asserted', () => {
    it('Then it returns without throwing (the bound is inclusive)', () => {
      // Arrange
      const sut = assertPatchTextFits;

      // Act
      const result = (): void => {
        sut(MAX_PATCH_TEXT_CHARS);
      };

      // Assert
      expect(result).not.toThrow();
    });
  });

  describe('Given a character count one past the ceiling, When the length is asserted', () => {
    it('Then it throws INVALID_DIFF_INPUT naming the count and the maximum', () => {
      // Arrange
      const sut = assertPatchTextFits;
      const chars = MAX_PATCH_TEXT_CHARS + 1;

      // Act + Assert
      try {
        sut(chars);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('INVALID_DIFF_INPUT');
        if (data.code === 'INVALID_DIFF_INPUT') {
          expect(data.reason).toBe(
            `rendered patch is ${chars} characters; the maximum is ${MAX_PATCH_TEXT_CHARS}`,
          );
        }
      }
    });
  });
});
