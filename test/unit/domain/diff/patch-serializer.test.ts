import { describe, expect, it } from 'vitest';
import { renderPatch } from '../../../../src/domain/diff/patch-serializer.js';

describe('patch-serializer', () => {
  describe('Given an empty PatchFile array', () => {
    describe('When renderPatch is called', () => {
      it('Then returns an empty string', () => {
        // Arrange
        const sut = renderPatch;

        // Act
        const result = sut([]);

        // Assert
        expect(result).toBe('');
      });
    });
  });
});
