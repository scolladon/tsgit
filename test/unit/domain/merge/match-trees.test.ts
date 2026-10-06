import { describe, expect, it } from 'vitest';
import {
  scoreTrees,
  shiftTree,
  shiftTreeBy,
  type TreeLister,
} from '../../../../src/domain/merge/match-trees.js';
import {
  FILE_MODE,
  type FileMode,
  type ObjectId,
  type TreeEntry,
  treeEntry,
} from '../../../../src/domain/objects/index.js';

const id = (name: string): ObjectId => name.padEnd(40, '0') as ObjectId;
const dir = (name: string, tree: string): TreeEntry =>
  treeEntry(FILE_MODE.DIRECTORY, name, id(tree));
const file = (name: string, blob: string, mode: FileMode = FILE_MODE.REGULAR): TreeEntry =>
  treeEntry(mode, name, id(blob));
const link = (name: string, blob: string): TreeEntry => file(name, blob, FILE_MODE.SYMLINK);

const listerOf =
  (trees: Readonly<Record<string, ReadonlyArray<TreeEntry>>>): TreeLister =>
  async (tree) =>
    tree === undefined ? [] : (trees[tree.replace(/0+$/, '')] ?? []);

describe('match-trees', () => {
  describe.each([
    ['a missing directory', [dir('d', 't1')], [], -1000],
    ['a missing symlink', [], [link('l', 'b1')], -500],
    ['a missing file', [file('f', 'b1')], [], -50],
    ['a differing directory and file', [dir('x', 't1')], [file('x', 'b1')], -1000 - 50],
    ['a differing symlink and file', [link('x', 'b1')], [file('x', 'b2')], -50],
    ['differing files', [file('x', 'b1')], [file('x', 'b2')], -5],
    ['differing directories', [dir('x', 't1')], [dir('x', 't2')], -5],
    ['matching directories', [dir('x', 't1')], [dir('x', 't1')], 1000],
    ['matching symlinks', [link('x', 'b1')], [link('x', 'b1')], 500],
    ['matching files', [file('x', 'b1')], [file('x', 'b1')], 250],
    ['a symlink and file sharing an id', [link('x', 'b1')], [file('x', 'b1')], -50],
    [
      'an executable and file sharing an id',
      [file('x', 'b1', FILE_MODE.EXECUTABLE)],
      [file('x', 'b1')],
      250,
    ],
  ] as const)('Given two trees holding %s', (_label, one, two, expected) => {
    describe('When scored', () => {
      it('Then the score is the one git gives', async () => {
        // Arrange
        const sut = scoreTrees;
        const list = listerOf({ one, two });

        // Act
        const result = await sut(list, id('one'), id('two'));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  const PROJECT = [file('a', 'ba'), file('b', 'bb'), file('c', 'bc')];
  const HOST = {
    host: [dir('lib', 'lib'), file('top', 'bt')],
    lib: [dir('sub', 'project')],
    project: PROJECT,
    side: [file('a', 'ba2'), file('b', 'bb'), file('c', 'bc')],
    deep: [dir('a', 'outer')],
    outer: [dir('b', 'middle')],
    middle: [dir('c', 'inner')],
    inner: [dir('d', 'project')],
  };

  describe.each([
    [
      'the side is the host’s nested subproject',
      'host',
      'side',
      { kind: 'add', prefix: 'lib/sub' },
    ],
    [
      'the side is the host the first tree is nested in',
      'side',
      'host',
      { kind: 'remove', prefix: 'lib/sub' },
    ],
    ['the trees already line up', 'host', 'host', { kind: 'none' }],
    ['the side lies one level past git’s search depth', 'deep', 'project', { kind: 'none' }],
    ['the side is the empty tree', 'host', undefined, { kind: 'add', prefix: 'lib/sub' }],
  ] as const)('Given %s', (_label, one, two, expected) => {
    describe('When shiftTree guesses the shift', () => {
      it('Then it picks the prefix git picks', async () => {
        // Arrange
        const sut = shiftTree;
        const list = listerOf(HOST);

        // Act
        const result = await sut(list, id(one), two === undefined ? undefined : id(two));

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each([
    ['neither tree has the prefix', 'host', 'side', 'nope', { kind: 'none' }],
    ['the prefix runs through a file', 'host', 'side', 'top/x', { kind: 'none' }],
    [
      'only the first tree has the prefix',
      'host',
      'side',
      'lib/sub/',
      { kind: 'add', prefix: 'lib/sub/' },
    ],
    [
      'only the side has the prefix',
      'side',
      'host',
      'lib/sub',
      { kind: 'remove', prefix: 'lib/sub' },
    ],
    [
      'both have it and adding scores best',
      'host',
      'nested',
      'lib',
      { kind: 'add', prefix: 'lib' },
    ],
    [
      'both have it and removing scores best',
      'nested',
      'host',
      'lib',
      { kind: 'remove', prefix: 'lib' },
    ],
    ['both have it and neither shift helps', 'host', 'host', 'lib', { kind: 'none' }],
  ] as const)('Given %s', (_label, one, two, prefix, expected) => {
    describe('When shiftTreeBy shifts by it', () => {
      it('Then it shifts the way git does', async () => {
        // Arrange
        const sut = shiftTreeBy;
        const list = listerOf({
          ...HOST,
          nested: [dir('lib', 'inner'), dir('sub', 'project')],
          inner: [file('q', 'bq')],
        });

        // Act
        const result = await sut(list, id(one), id(two), prefix);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
