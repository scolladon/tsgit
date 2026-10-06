import { describe, expect, it } from 'vitest';
import type { FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import { trivialMerge } from '../../../../src/domain/merge/trivial-merge.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';

const BLOB = '100644' as FileMode;
const entry = (id: string, mode: FileMode = BLOB): FlatTreeEntry => ({
  id: id.padEnd(40, '0') as ObjectId,
  mode,
});
const tree = (entries: Record<string, FlatTreeEntry>): ReadonlyMap<FilePath, FlatTreeEntry> =>
  new Map(Object.entries(entries) as Array<[FilePath, FlatTreeEntry]>);

describe('trivialMerge', () => {
  describe.each([
    [
      'only theirs changed it',
      { f: entry('a') },
      { f: entry('a') },
      { f: entry('b') },
      { f: entry('b') },
    ],
    [
      'only ours changed it',
      { f: entry('a') },
      { f: entry('b') },
      { f: entry('a') },
      { f: entry('b') },
    ],
    [
      'both made the same change',
      { f: entry('a') },
      { f: entry('b') },
      { f: entry('b') },
      { f: entry('b') },
    ],
    ['only theirs added it', {}, {}, { f: entry('b') }, { f: entry('b') }],
    ['only ours added it', {}, { f: entry('b') }, {}, { f: entry('b') }],
    [
      'only its mode changed on theirs',
      { f: entry('a') },
      { f: entry('a') },
      { f: entry('a', '100755' as FileMode) },
      { f: entry('a', '100755' as FileMode) },
    ],
  ])('Given a path %s', (_label, base, ours, theirs, expected) => {
    describe('When merged trivially', () => {
      it('Then the changed side is kept', () => {
        // Arrange
        const sut = trivialMerge;

        // Act
        const result = sut(tree(base), tree(ours), tree(theirs));

        // Assert
        expect(result).toEqual(tree(expected));
      });
    });
  });

  describe.each([
    ['both changed it differently', { f: entry('a') }, { f: entry('b') }, { f: entry('c') }],
    ['theirs deleted it', { f: entry('a') }, { f: entry('a') }, {}],
    ['ours deleted it', { f: entry('a') }, {}, { f: entry('a') }],
    ['both deleted it', { f: entry('a') }, {}, {}],
    ['both added it differently', {}, { f: entry('b') }, { f: entry('c') }],
    [
      'ours added a file where theirs added a directory',
      {},
      { d: entry('b') },
      { 'd/x': entry('c') },
    ],
  ])('Given a path %s', (_label, base, ours, theirs) => {
    describe('When merged trivially', () => {
      it('Then it needs a file-level merge', () => {
        // Arrange
        const sut = trivialMerge;

        // Act
        const result = sut(tree(base), tree(ours), tree(theirs));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
