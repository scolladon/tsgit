import { describe, expect, it } from 'vitest';
import { comparePaths, sortByPath } from '../../../../src/domain/diff/path-compare.js';
import type { FilePath } from '../../../../src/domain/objects/index.js';

describe('comparePaths', () => {
  describe('Given two identical paths', () => {
    describe('When comparePaths called', () => {
      it('Then returns 0', () => {
        // Arrange & Act
        const result = comparePaths('foo' as FilePath, 'foo' as FilePath);

        // Assert
        expect(result).toBe(0);
      });
    });
  });

  describe('Given a < b in byte order', () => {
    describe('When comparePaths called', () => {
      it('Then returns negative', () => {
        // Arrange & Act
        const result = comparePaths('a' as FilePath, 'b' as FilePath);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given a > b in byte order', () => {
    describe('When comparePaths called', () => {
      it('Then returns positive', () => {
        // Arrange & Act
        const result = comparePaths('b' as FilePath, 'a' as FilePath);

        // Assert
        expect(result).toBeGreaterThan(0);
      });
    });
  });

  describe('Given multibyte UTF-8 paths', () => {
    describe('When comparePaths called', () => {
      it('Then compares by byte order not codepoint', () => {
        // Arrange & Act
        // U+00E9 (é) encodes as 0xC3 0xA9 in UTF-8, which is > 0x7A ('z')
        const result = comparePaths('z' as FilePath, 'é' as FilePath);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });
});

describe('sortByPath', () => {
  describe('Given unsorted items', () => {
    describe('When sortByPath called', () => {
      it('Then returns items sorted by path byte order', () => {
        // Arrange
        const items = [
          { name: 'c', path: 'c' as FilePath },
          { name: 'a', path: 'a' as FilePath },
          { name: 'b', path: 'b' as FilePath },
        ];

        // Act
        const result = sortByPath(items, (i) => i.path);

        // Assert
        expect(result.map((i) => i.name)).toEqual(['a', 'b', 'c']);
      });
    });
  });

  describe('Given empty array', () => {
    describe('When sortByPath called', () => {
      it('Then returns empty array', () => {
        // Arrange & Act
        const result = sortByPath([], (i: { path: FilePath }) => i.path);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given sortByPath called', () => {
    describe('When checking original array', () => {
      it('Then original is not mutated', () => {
        // Arrange
        const items = [{ path: 'b' as FilePath }, { path: 'a' as FilePath }];
        const original = [...items];

        // Act
        sortByPath(items, (i) => i.path);

        // Assert
        expect(items).toEqual(original);
      });
    });
  });
});
