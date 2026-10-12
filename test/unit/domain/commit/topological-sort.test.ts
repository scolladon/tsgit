import { describe, expect, it } from 'vitest';
import {
  sortInTopologicalOrder,
  type TopoSortable,
} from '../../../../src/domain/commit/topological-sort.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const oid = (name: string): ObjectId => name.padEnd(40, '0') as ObjectId;

const node = (
  name: string,
  parents: ReadonlyArray<string>,
  dates: { readonly committed: number; readonly authored?: number } = { committed: 0 },
): TopoSortable => ({
  id: oid(name),
  data: {
    parents: parents.map(oid),
    committer: { timestamp: dates.committed },
    author: { timestamp: dates.authored ?? dates.committed },
  },
});

const names = (sorted: ReadonlyArray<TopoSortable>): string[] =>
  sorted.map((commit) => commit.id.replace(/0+$/, ''));

const octopus: ReadonlyArray<TopoSortable> = [
  node('e', ['a', 'b', 'c', 'd']),
  node('a', ['f']),
  node('b', ['f']),
  node('c', ['f']),
  node('d', ['f']),
  node('f', []),
];

describe('Given an octopus merge whose commits share one date', () => {
  describe('When sorting in graph order', () => {
    it('Then the last-listed parent line shows first, as a stack', () => {
      // Arrange
      const sut = sortInTopologicalOrder;

      // Act
      const result = sut(octopus, 'graph');

      // Assert
      expect(names(result)).toEqual(['e', 'd', 'c', 'b', 'a', 'f']);
    });
  });

  describe('When sorting by commit date', () => {
    it('Then equal dates show in the order their last child released them', () => {
      // Arrange
      const sut = sortInTopologicalOrder;

      // Act
      const result = sut(octopus, 'commit-date');

      // Assert
      expect(names(result)).toEqual(['e', 'a', 'b', 'c', 'd', 'f']);
    });
  });
});

describe('Given two unrelated tips', () => {
  describe('When sorting in graph order', () => {
    it('Then the tips show in the order given', () => {
      // Arrange
      const sut = sortInTopologicalOrder;
      const commits = [node('b', []), node('a', [])];

      // Act
      const result = sut(commits, 'graph');

      // Assert
      expect(names(result)).toEqual(['b', 'a']);
    });
  });
});

describe('Given a parent newer than one of its two children', () => {
  // e ← {a, b}; a and b both ← f; b is older than f (clock skew)
  const skewed = [
    node('e', ['a', 'b'], { committed: 10 }),
    node('a', ['f'], { committed: 9 }),
    node('f', [], { committed: 8 }),
    node('b', ['f'], { committed: 1 }),
  ];

  describe('When sorting by commit date', () => {
    it('Then the parent is held back until its older child shows', () => {
      // Arrange
      const sut = sortInTopologicalOrder;

      // Act
      const result = sut(skewed, 'commit-date');

      // Assert
      expect(names(result)).toEqual(['e', 'a', 'b', 'f']);
    });
  });
});

describe('Given children whose author dates order opposite to their commit dates', () => {
  const commits = [
    node('e', ['a', 'b'], { committed: 10, authored: 10 }),
    node('a', [], { committed: 9, authored: 1 }),
    node('b', [], { committed: 1, authored: 9 }),
  ];

  describe('When sorting by author date', () => {
    it('Then the newer author date shows first', () => {
      // Arrange
      const sut = sortInTopologicalOrder;

      // Act
      const result = sut(commits, 'author-date');

      // Assert
      expect(names(result)).toEqual(['e', 'b', 'a']);
    });
  });

  describe('When sorting by commit date', () => {
    it('Then the newer commit date shows first', () => {
      // Arrange
      const sut = sortInTopologicalOrder;

      // Act
      const result = sut(commits, 'commit-date');

      // Assert
      expect(names(result)).toEqual(['e', 'a', 'b']);
    });
  });
});

describe('Given a commit whose parent lies outside the list', () => {
  describe('When sorting in graph order', () => {
    it('Then the outside parent is ignored', () => {
      // Arrange
      const sut = sortInTopologicalOrder;
      const commits = [node('e', ['x', 'a']), node('a', [])];

      // Act
      const result = sut(commits, 'graph');

      // Assert
      expect(names(result)).toEqual(['e', 'a']);
    });
  });
});

describe('Given an empty list', () => {
  describe('When sorting', () => {
    it('Then nothing is returned', () => {
      // Arrange
      const sut = sortInTopologicalOrder;

      // Act
      const result = sut([], 'graph');

      // Assert
      expect(result).toEqual([]);
    });
  });
});
