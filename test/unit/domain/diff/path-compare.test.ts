import { describe, expect, it } from 'vitest';
import { comparePaths, sortByPath } from '../../../../src/domain/diff/path-compare.js';
import type { FilePath } from '../../../../src/domain/objects/index.js';

describe('comparePaths', () => {
  it('Given two identical paths, When comparePaths called, Then returns 0', () => {
    // Arrange & Act
    const sut = comparePaths('foo' as FilePath, 'foo' as FilePath);

    // Assert
    expect(sut).toBe(0);
  });

  it('Given a < b in byte order, When comparePaths called, Then returns negative', () => {
    // Arrange & Act
    const sut = comparePaths('a' as FilePath, 'b' as FilePath);

    // Assert
    expect(sut).toBeLessThan(0);
  });

  it('Given a > b in byte order, When comparePaths called, Then returns positive', () => {
    // Arrange & Act
    const sut = comparePaths('b' as FilePath, 'a' as FilePath);

    // Assert
    expect(sut).toBeGreaterThan(0);
  });

  it('Given multibyte UTF-8 paths, When comparePaths called, Then compares by byte order not codepoint', () => {
    // Arrange & Act
    // U+00E9 (é) encodes as 0xC3 0xA9 in UTF-8, which is > 0x7A ('z')
    const sut = comparePaths('z' as FilePath, 'é' as FilePath);

    // Assert
    expect(sut).toBeLessThan(0);
  });
});

describe('sortByPath', () => {
  it('Given unsorted items, When sortByPath called, Then returns items sorted by path byte order', () => {
    // Arrange
    const items = [
      { name: 'c', path: 'c' as FilePath },
      { name: 'a', path: 'a' as FilePath },
      { name: 'b', path: 'b' as FilePath },
    ];

    // Act
    const sut = sortByPath(items, (i) => i.path);

    // Assert
    expect(sut.map((i) => i.name)).toEqual(['a', 'b', 'c']);
  });

  it('Given empty array, When sortByPath called, Then returns empty array', () => {
    // Arrange & Act
    const sut = sortByPath([], (i: { path: FilePath }) => i.path);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given sortByPath called, When checking original array, Then original is not mutated', () => {
    // Arrange
    const items = [{ path: 'b' as FilePath }, { path: 'a' as FilePath }];
    const original = [...items];

    // Act
    sortByPath(items, (i) => i.path);

    // Assert
    expect(items).toEqual(original);
  });
});
