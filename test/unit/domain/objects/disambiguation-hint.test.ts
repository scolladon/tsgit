import { describe, expect, it } from 'vitest';
import { parseDisambiguationHint } from '../../../../src/domain/objects/disambiguation-hint.js';

describe('parseDisambiguationHint', () => {
  describe.each([
    { value: 'none', expected: 'none' },
    { value: 'commit', expected: 'commit' },
    { value: 'COMMIT', expected: 'commit' },
    { value: 'committish', expected: 'committish' },
    { value: 'tree', expected: 'tree' },
    { value: 'TreeIsh', expected: 'treeish' },
    { value: 'blob', expected: 'blob' },
  ])('Given the value $value', ({ value, expected }) => {
    describe('When it is parsed', () => {
      it(`Then it names the ${expected} hint`, () => {
        // Arrange
        const sut = parseDisambiguationHint;

        // Act
        const result = sut(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe.each(['bogus', '', 'commit ', 'commits'])('Given the value "%s"', (value) => {
    describe('When it is parsed', () => {
      it('Then it names no hint', () => {
        // Arrange
        const sut = parseDisambiguationHint;

        // Act
        const result = sut(value);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
