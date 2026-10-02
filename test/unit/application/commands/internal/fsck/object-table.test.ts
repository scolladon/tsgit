import { describe, expect, it } from 'vitest';
import type { CachedGitObject } from '../../../../../../src/application/commands/internal/fsck/object-cache.js';
import {
  buildObjectTable,
  type ReadCopy,
} from '../../../../../../src/application/commands/internal/fsck/object-table.js';
import { FILE_MODE } from '../../../../../../src/domain/objects/file-mode.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../../src/domain/objects/tree.js';

const oid = (digit: string): ObjectId => digit.repeat(40) as ObjectId;

const BLOB = oid('1');
const TREE = oid('2');
const COMMIT = oid('3');
const TAG = oid('4');
const OTHER = oid('5');
const SUB = oid('6');
const NO_TIPS: ReadonlyArray<ObjectId> = [];
const NONE_REFUSED: ReadonlySet<ObjectId> = new Set();

const loose = (...ids: ReadonlyArray<ObjectId>): ReadonlyArray<ReadCopy> =>
  ids.map((id) => ({ id }));

const cacheOf = (
  entries: ReadonlyArray<readonly [ObjectId, CachedGitObject]>,
): ReadonlyMap<ObjectId, CachedGitObject> => new Map(entries);

const commitOver = (tree: ObjectId, parents: ReadonlyArray<ObjectId> = []): CachedGitObject => ({
  type: 'commit',
  tree,
  parents,
});

describe('buildObjectTable', () => {
  describe('Given a ref tip commit whose tree is another tip, a commit over a blob', () => {
    describe('When the table is built', () => {
      it('Then the commit tip types none of its links and its read refuses it', () => {
        // Arrange
        const cache = cacheOf([
          [COMMIT, commitOver(OTHER)],
          [OTHER, commitOver(BLOB)],
          [BLOB, { type: 'blob' }],
        ]);
        const sut = buildObjectTable;

        // Act
        const result = sut(loose(OTHER, BLOB), [COMMIT, OTHER], cache, NONE_REFUSED);

        // Assert
        expect(result.findings).toEqual([
          { type: 'type-conflict', id: OTHER, objectType: 'tree', expectedType: 'commit' },
          { type: 'unparseable-object', id: OTHER },
        ]);
        expect([...result.unparsed]).toEqual([OTHER]);
      });
    });
  });

  describe('Given a ref tip commit whose parent the other tip typed a tree', () => {
    describe('When the table is built', () => {
      it('Then the tip parse fails and its read reports the bad parent', () => {
        // Arrange
        const cache = cacheOf([
          [OTHER, commitOver(TREE)],
          [COMMIT, commitOver(TREE, [TREE])],
        ]);
        const sut = buildObjectTable;

        // Act
        const result = sut(loose(COMMIT), [OTHER, COMMIT], cache, NONE_REFUSED);

        // Assert
        expect(result.findings).toEqual([
          { type: 'type-conflict', id: TREE, objectType: 'tree', expectedType: 'commit' },
          { type: 'bad-pointer', id: COMMIT, link: 'parent', target: TREE },
          { type: 'unparseable-object', id: COMMIT },
        ]);
        expect(result.exitBit).toBe(1);
      });
    });
  });

  describe('Given a parsed ref tip read again as a copy', () => {
    describe('When the table is built', () => {
      it('Then its links are not looked up a second time', () => {
        // Arrange
        const cache = cacheOf([
          [TAG, { type: 'tag', object: BLOB, objectType: 'tree', tagName: 'v' }],
        ]);
        const sut = buildObjectTable;

        // Act
        const result = sut(loose(TAG), [TAG], cache, NONE_REFUSED);

        // Assert
        expect(result.findings).toEqual([]);
        expect(result.unparsed.size).toBe(0);
      });
    });
  });

  describe('Given a pack entry read after a loose copy typed it otherwise', () => {
    describe('When the table is built', () => {
      it('Then the entry is unparseable in its pack, with bits 1 and 4', () => {
        // Arrange
        const cache = cacheOf([
          [COMMIT, commitOver(BLOB)],
          [BLOB, { type: 'blob' }],
        ]);
        const copies: ReadonlyArray<ReadCopy> = [
          { id: COMMIT },
          { id: BLOB, pack: 'pack-a', objectsDir: '/alt' },
        ];
        const sut = buildObjectTable;

        // Act
        const result = sut(copies, NO_TIPS, cache, NONE_REFUSED);

        // Assert
        expect(result.findings).toEqual([
          { type: 'type-conflict', id: BLOB, objectType: 'tree', expectedType: 'blob' },
          { type: 'unparseable-object', id: BLOB, pack: 'pack-a', objectsDir: '/alt' },
        ]);
        expect(result.exitBit).toBe(5);
      });
    });
  });

  describe('Given an object read as two copies', () => {
    describe('When the table is built', () => {
      it('Then only its first copy is parsed', () => {
        // Arrange
        const cache = cacheOf([
          [TREE, { type: 'blob' }],
          [OTHER, commitOver(TREE)],
        ]);
        const copies: ReadonlyArray<ReadCopy> = [
          { id: OTHER },
          { id: TREE },
          { id: TREE, pack: 'pack-a' },
        ];
        const sut = buildObjectTable;

        // Act
        const result = sut(copies, NO_TIPS, cache, NONE_REFUSED);

        // Assert
        expect(result.findings).toEqual([
          { type: 'type-conflict', id: TREE, objectType: 'tree', expectedType: 'blob' },
          { type: 'unparseable-object', id: TREE },
        ]);
      });
    });
  });

  describe('Given copies the content check refused or no reader typed', () => {
    describe('When the table is built', () => {
      it('Then neither is parsed nor types its links', () => {
        // Arrange
        const cache = cacheOf([
          [COMMIT, commitOver(BLOB)],
          [OTHER, null],
          [BLOB, { type: 'blob' }],
        ]);
        const sut = buildObjectTable;

        // Act
        const result = sut(loose(COMMIT, OTHER, BLOB), [OTHER], cache, new Set([COMMIT]));

        // Assert
        expect(result.findings).toEqual([]);
        expect(result.unparsed.size).toBe(0);
      });
    });
  });

  describe('Given a tree whose gitlink and file entry each name a tree', () => {
    describe('When the table is built', () => {
      it('Then only the file entry is unresolved, with broken links and bit 1', () => {
        // Arrange
        const cache = cacheOf([
          [SUB, { type: 'tree', entries: [] }],
          [OTHER, { type: 'tree', entries: [] }],
          [
            TREE,
            {
              type: 'tree',
              entries: [
                treeEntry(FILE_MODE.GITLINK, 'g', SUB),
                treeEntry(FILE_MODE.REGULAR, 'f', OTHER),
              ],
            },
          ],
        ]);
        const conflict = {
          type: 'type-conflict',
          id: OTHER,
          objectType: 'tree',
          expectedType: 'blob',
        } as const;
        const sut = buildObjectTable;

        // Act
        const result = sut(loose(SUB, OTHER, TREE), NO_TIPS, cache, NONE_REFUSED);

        // Assert
        expect(result.findings).toEqual([
          conflict,
          { type: 'broken-links', id: TREE, objectType: 'tree' },
        ]);
        expect([...result.unresolvedEntries]).toEqual([[TREE, [conflict]]]);
        expect(result.exitBit).toBe(1);
      });
    });
  });
});
