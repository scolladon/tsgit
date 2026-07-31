import { describe, expect, it } from 'vitest';
import {
  assertPatchTextFits,
  joinedLength,
  joinedLineLength,
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

describe('joinedLineLength', () => {
  describe('Given a rendered line, When its joined length is taken', () => {
    it('Then it counts the line plus the separator that follows it', () => {
      // Arrange
      const sut = joinedLineLength;

      // Act
      const result = sut('+abc');

      // Assert
      expect(result).toBe('+abc\n'.length);
    });
  });

  describe('Given an empty rendered line, When its joined length is taken', () => {
    it('Then it counts the separator alone', () => {
      // Arrange
      const sut = joinedLineLength;

      // Act
      const result = sut('');

      // Assert
      expect(result).toBe(1);
    });
  });
});

describe('joinedLength', () => {
  describe('Given no lines at all, When the joined length is taken', () => {
    it('Then it is zero — an empty patch renders as the empty string', () => {
      // Arrange
      const sut = joinedLength;

      // Act
      const result = sut([]);

      // Assert
      expect(result).toBe(['', ''].slice(1).join('\n').length);
      expect(result).toBe(0);
    });
  });

  describe('Given a handful of rendered lines, When the joined length is taken', () => {
    it('Then it equals the length of the string the renderer actually materialises', () => {
      // Arrange
      const lines = ['diff --git a/f b/f', '@@ -1 +1 @@', '-old', '+new', ''];
      const sut = joinedLength;

      // Act
      const result = sut(lines);

      // Assert
      expect(result).toBe([...lines, ''].join('\n').length);
    });
  });
});
