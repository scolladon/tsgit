import { describe, expect, it } from 'vitest';
import { normalizePathCopy } from '../../../../src/domain/path/normalize-path-copy.js';

describe('normalizePathCopy', () => {
  describe.each([
    { path: './g', expected: 'g' },
    { path: './d/../g', expected: 'g' },
    { path: './d/./f', expected: 'd/f' },
    { path: './', expected: '' },
    { path: './/d//f', expected: 'd/f' },
    { path: './d/', expected: 'd/' },
    { path: './a/.', expected: 'a/' },
    { path: './a/b/..', expected: 'a/' },
    { path: './a/..', expected: '' },
    { path: './.../x', expected: '.../x' },
  ])('Given the relative path $path', ({ path, expected }) => {
    describe('When it is normalised', () => {
      it(`Then it reads ${JSON.stringify(expected)}`, () => {
        // Arrange
        const sut = normalizePathCopy;

        // Act
        const result = sut(path);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe.each(['../g', './d/../../g', './..'])(
    'Given the relative path %s climbing above its start',
    (path) => {
      describe('When it is normalised', () => {
        it('Then it is refused', () => {
          // Arrange
          const sut = normalizePathCopy;

          // Act
          const result = sut(path);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    },
  );
});
