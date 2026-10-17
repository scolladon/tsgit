import { describe, expect, it } from 'vitest';
import {
  invalidateCacheTree,
  serializeCacheTree,
} from '../../../../src/domain/git-index/cache-tree.js';
import {
  carryExtensions,
  NO_INDEX_CHANGE,
  withResolveUndo,
  withRestagedPaths,
} from '../../../../src/domain/git-index/carry-extensions.js';
import {
  diffIndexEntries,
  type IndexChange,
} from '../../../../src/domain/git-index/diff-index-entries.js';
import {
  type CacheTreeEntry,
  type IndexEntry,
  type IndexExtension,
  STAGE0_FLAGS,
} from '../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
import {
  parseResolveUndo,
  type ResolveUndoRecord,
  serializeResolveUndo,
} from '../../../../src/domain/git-index/resolve-undo.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';

const oid = (hexLength: 40 | 64, digit: string): ObjectId => digit.repeat(hexLength) as ObjectId;

const cacheTree = (hexLength: 40 | 64): CacheTreeEntry => ({
  path: '',
  entryCount: 3,
  subtreeCount: 1,
  id: oid(hexLength, 'a'),
  children: [{ path: 'd', entryCount: 2, subtreeCount: 0, id: oid(hexLength, 'b'), children: [] }],
});

const extension = (signature: string, data: Uint8Array): IndexExtension => ({ signature, data });

const previousExtensions = (digestLength: 20 | 32 = 20): ReadonlyArray<IndexExtension> => {
  const hexLength = digestLength === 20 ? 40 : 64;
  return [
    extension('EOIE', new Uint8Array([1])),
    extension('ZZZZ', new Uint8Array([2])),
    extension('UNTR', new Uint8Array([3])),
    extension('REUC', new Uint8Array([4])),
    extension('TREE', serializeCacheTree(cacheTree(hexLength), digestLength)),
  ];
};

const settings = { untrackedCache: undefined, digestLength: 20 } as const;

const signaturesOf = (extensions: ReadonlyArray<IndexExtension>): ReadonlyArray<string> =>
  extensions.map((e) => e.signature);

describe('carryExtensions', () => {
  describe('Given TREE, REUC, UNTR, ZZZZ and EOIE', () => {
    describe("When carried with no change on a 'refresh'", () => {
      it('Then TREE, REUC and UNTR come back as the same objects in that order', () => {
        // Arrange
        const previous = previousExtensions();

        // Act
        const sut = carryExtensions;
        const result = sut(previous, NO_INDEX_CHANGE, 'refresh', settings);

        // Assert
        const byName = (name: string) => previous.find((e) => e.signature === name);
        expect(result).toEqual([byName('TREE'), byName('REUC'), byName('UNTR')]);
        expect(result[0]).toBe(byName('TREE'));
        expect(result[1]).toBe(byName('REUC'));
        expect(result[2]).toBe(byName('UNTR'));
        expect(signaturesOf(result)).not.toContain('ZZZZ');
        expect(signaturesOf(result)).not.toContain('EOIE');
      });
    });
  });

  describe('Given TREE, REUC, UNTR, ZZZZ and EOIE', () => {
    describe("When carried on a 'refresh' whose change reports every kind of difference", () => {
      it('Then TREE, REUC and UNTR come back as the same objects', () => {
        // Arrange
        const previous = previousExtensions();
        const change: IndexChange = {
          changedPaths: [{ path: 'd/c' as FilePath }],
          trackedSetChanged: true,
          resolvedUnmerged: true,
        };

        // Act
        const sut = carryExtensions;
        const result = sut(previous, change, 'refresh', settings);

        // Assert
        expect(result).toHaveLength(3);
        expect(result[0]).toBe(previous[4]);
        expect(result[1]).toBe(previous[3]);
        expect(result[2]).toBe(previous[2]);
      });
    });
  });

  describe('Given TREE, REUC, UNTR, ZZZZ and EOIE', () => {
    describe("When carried on an 'update'", () => {
      it('Then TREE is the serialised invalidated tree and REUC and UNTR are kept', () => {
        // Arrange
        const previous = previousExtensions();
        const change: IndexChange = {
          ...NO_INDEX_CHANGE,
          changedPaths: [{ path: 'd/c' as FilePath }],
        };
        const invalidated = invalidateCacheTree(cacheTree(40), change.changedPaths);

        // Act
        const sut = carryExtensions;
        const result = sut(previous, change, 'update', settings);

        // Assert
        expect(signaturesOf(result)).toEqual(['TREE', 'REUC', 'UNTR']);
        expect(result[0]?.data).toEqual(serializeCacheTree(invalidated, 20));
        expect(result[1]).toBe(previous[3]);
        expect(result[2]).toBe(previous[2]);
      });

      it('Then an empty changedPaths returns the previous TREE object', () => {
        // Arrange
        const previous = previousExtensions();

        // Act
        const sut = carryExtensions;
        const result = sut(previous, NO_INDEX_CHANGE, 'update', settings);

        // Assert
        expect(result[0]).toBe(previous[4]);
      });

      it('Then a resolved unmerged entry drops REUC', () => {
        // Arrange
        const change: IndexChange = { ...NO_INDEX_CHANGE, resolvedUnmerged: true };

        // Act
        const sut = carryExtensions;
        const result = sut(previousExtensions(), change, 'update', settings);

        // Assert
        expect(signaturesOf(result)).toEqual(['TREE', 'UNTR']);
      });

      it('Then a changed tracked set drops UNTR', () => {
        // Arrange
        const change: IndexChange = { ...NO_INDEX_CHANGE, trackedSetChanged: true };

        // Act
        const sut = carryExtensions;
        const result = sut(previousExtensions(), change, 'update', settings);

        // Assert
        expect(signaturesOf(result)).toEqual(['TREE', 'REUC']);
      });

      it('Then a TREE naming the same subtree twice is dropped and the others are kept', () => {
        // Arrange
        const change: IndexChange = {
          ...NO_INDEX_CHANGE,
          changedPaths: [{ path: 'd/c' as FilePath }],
        };
        const twin = cacheTree(40).children[0] as CacheTreeEntry;
        const duplicated: CacheTreeEntry = {
          ...cacheTree(40),
          subtreeCount: 2,
          children: [twin, twin],
        };
        const previous = previousExtensions().map((e) =>
          e.signature === 'TREE' ? extension('TREE', serializeCacheTree(duplicated, 20)) : e,
        );

        // Act
        const sut = carryExtensions;
        const result = sut(previous, change, 'update', settings);

        // Assert
        expect(signaturesOf(result)).toEqual(['REUC', 'UNTR']);
      });

      it('Then a TREE naming the same subtree twice below the root is dropped and the others are kept', () => {
        // Arrange
        const change: IndexChange = {
          ...NO_INDEX_CHANGE,
          changedPaths: [{ path: 'x' as FilePath }],
        };
        const leaf = (path: string): CacheTreeEntry => ({
          path,
          entryCount: 1,
          subtreeCount: 0,
          id: oid(40, 'b'),
          children: [],
        });
        const nested: CacheTreeEntry = {
          ...cacheTree(40),
          children: [{ ...leaf('a'), subtreeCount: 2, children: [leaf('d'), leaf('d')] }],
        };
        const previous = previousExtensions().map((e) =>
          e.signature === 'TREE' ? extension('TREE', serializeCacheTree(nested, 20)) : e,
        );

        // Act
        const sut = carryExtensions;
        const result = sut(previous, change, 'update', settings);

        // Assert
        expect(signaturesOf(result)).toEqual(['REUC', 'UNTR']);
      });

      it('Then a corrupt TREE payload is dropped and the others are kept', () => {
        // Arrange
        const change: IndexChange = {
          ...NO_INDEX_CHANGE,
          changedPaths: [{ path: 'd/c' as FilePath }],
        };
        const previous = previousExtensions().map((e) =>
          e.signature === 'TREE' ? extension('TREE', new Uint8Array([0xff, 0xff])) : e,
        );

        // Act
        const sut = carryExtensions;
        const result = sut(previous, change, 'update', settings);

        // Assert
        expect(signaturesOf(result)).toEqual(['REUC', 'UNTR']);
      });
    });
  });

  describe('Given TREE, REUC, UNTR, ZZZZ and EOIE', () => {
    describe("When carried on a 'replace'", () => {
      it('Then REUC is dropped and TREE is invalidated', () => {
        // Arrange
        const change: IndexChange = {
          ...NO_INDEX_CHANGE,
          changedPaths: [{ path: 'd/c' as FilePath }],
        };
        const invalidated = invalidateCacheTree(cacheTree(40), change.changedPaths);

        // Act
        const sut = carryExtensions;
        const result = sut(previousExtensions(), change, 'replace', settings);

        // Assert
        expect(signaturesOf(result)).toEqual(['TREE', 'UNTR']);
        expect(result[0]?.data).toEqual(serializeCacheTree(invalidated, 20));
      });

      it('Then UNTR is kept while the tracked set is unchanged', () => {
        // Arrange
        const previous = previousExtensions();

        // Act
        const sut = carryExtensions;
        const result = sut(previous, NO_INDEX_CHANGE, 'replace', settings);

        // Assert
        expect(result[1]).toBe(previous[2]);
      });

      it('Then UNTR is dropped when the tracked set changed', () => {
        // Arrange
        const change: IndexChange = { ...NO_INDEX_CHANGE, trackedSetChanged: true };

        // Act
        const sut = carryExtensions;
        const result = sut(previousExtensions(), change, 'replace', settings);

        // Assert
        expect(signaturesOf(result)).toEqual(['TREE']);
      });
    });
  });

  describe('Given core.untrackedCache is false', () => {
    describe.each(['refresh', 'update', 'replace'] as const)("When carried on a '%s'", (kind) => {
      it('Then UNTR is dropped', () => {
        // Arrange
        const disabled = { untrackedCache: false, digestLength: 20 } as const;

        // Act
        const sut = carryExtensions;
        const result = sut(previousExtensions(), NO_INDEX_CHANGE, kind, disabled);

        // Assert
        expect(signaturesOf(result)).not.toContain('UNTR');
      });
    });
  });

  describe('Given core.untrackedCache is true', () => {
    describe("When carried on a 'refresh'", () => {
      it('Then UNTR is kept', () => {
        // Arrange
        const enabled = { untrackedCache: true, digestLength: 20 } as const;

        // Act
        const sut = carryExtensions;
        const result = sut(previousExtensions(), NO_INDEX_CHANGE, 'refresh', enabled);

        // Assert
        expect(signaturesOf(result)).toContain('UNTR');
      });
    });
  });

  describe('Given no previous extensions', () => {
    describe("When carried on an 'update'", () => {
      it('Then nothing is carried', () => {
        // Arrange
        const previous: ReadonlyArray<IndexExtension> = [];

        // Act
        const sut = carryExtensions;
        const result = sut(previous, NO_INDEX_CHANGE, 'update', settings);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a SHA-256 TREE', () => {
    describe("When carried on an 'update' with a changed path", () => {
      it('Then TREE is the 32-byte-digest serialisation of the invalidated tree', () => {
        // Arrange
        const wide = { untrackedCache: undefined, digestLength: 32 } as const;
        const change: IndexChange = {
          ...NO_INDEX_CHANGE,
          changedPaths: [{ path: 'd/c' as FilePath }],
        };
        const invalidated = invalidateCacheTree(cacheTree(64), change.changedPaths);

        // Act
        const sut = carryExtensions;
        const result = sut(previousExtensions(32), change, 'update', wide);

        // Assert
        expect(result[0]?.data).toEqual(serializeCacheTree(invalidated, 32));
      });
    });
  });

  describe('Given a change on d/c', () => {
    describe('When withRestagedPaths adds b and d/c', () => {
      it('Then changedPaths is the UTF-8 byte-ordered union, each path once, flags kept', () => {
        // Arrange
        const change: IndexChange = {
          changedPaths: [{ path: 'd/c' as FilePath }],
          trackedSetChanged: true,
          resolvedUnmerged: true,
        };

        // Act
        const sut = withRestagedPaths;
        const result = sut(change, [{ path: 'd/c' as FilePath }, { path: 'b' as FilePath }]);

        // Assert
        expect(result).toEqual({
          changedPaths: [{ path: 'b' }, { path: 'd/c' }],
          trackedSetChanged: true,
          resolvedUnmerged: true,
        });
      });

      it('Then the union orders by UTF-8 bytes, not UTF-16 code units', () => {
        // Arrange
        const change: IndexChange = {
          ...NO_INDEX_CHANGE,
          changedPaths: [{ path: '\u{1F600}' as FilePath }],
        };

        // Act
        const sut = withRestagedPaths;
        const result = sut(change, [{ path: '\uFF5E' as FilePath }]);

        // Assert
        expect(result.changedPaths).toEqual([{ path: '\uFF5E' }, { path: '\u{1F600}' }]);
      });
    });

    describe('When a raw-byte path is changed and its decoded twin is restaged', () => {
      it('Then both survive, the literal one ordered first', () => {
        // Arrange
        const lossy = {
          path: '\uFFFD.txt' as FilePath,
          pathBytes: Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74),
        };
        const change: IndexChange = { ...NO_INDEX_CHANGE, changedPaths: [lossy] };

        // Act
        const sut = withRestagedPaths;
        const result = sut(change, [{ path: '\uFFFD.txt' as FilePath }]);

        // Assert
        expect(result.changedPaths).toEqual([{ path: '\uFFFD.txt' }, lossy]);
      });
    });

    describe('When withRestagedPaths adds nothing', () => {
      it('Then the same change object is returned', () => {
        // Arrange
        const change: IndexChange = {
          ...NO_INDEX_CHANGE,
          changedPaths: [{ path: 'd/c' as FilePath }],
        };

        // Act
        const sut = withRestagedPaths;
        const result = sut(change, []);

        // Assert
        expect(result).toBe(change);
      });
    });
  });

  describe('Given a lossy entry whose bytes name a valid subtree of the cache tree', () => {
    describe("When its change from diffIndexEntries is carried on an 'update'", () => {
      it('Then the subtree is invalidated', () => {
        // Arrange
        const tree: CacheTreeEntry = {
          path: '',
          entryCount: 1,
          subtreeCount: 1,
          id: oid(40, 'a'),
          children: [
            {
              path: '\uFFFD',
              nameBytes: Uint8Array.of(0xff),
              entryCount: 1,
              subtreeCount: 0,
              id: oid(40, 'b'),
              children: [],
            },
          ],
        };
        const lossyEntry = (id: string): IndexEntry => ({
          ctimeSeconds: 0,
          ctimeNanoseconds: 0,
          mtimeSeconds: 0,
          mtimeNanoseconds: 0,
          dev: 0,
          ino: 0,
          mode: FILE_MODE.REGULAR,
          uid: 0,
          gid: 0,
          fileSize: 0,
          id: oid(40, id),
          flags: STAGE0_FLAGS,
          path: '\uFFFD/x' as FilePath,
          pathBytes: Uint8Array.of(0xff, 0x2f, 0x78),
        });
        const change = diffIndexEntries([lossyEntry('c')], [lossyEntry('d')]);
        const previous = [extension('TREE', serializeCacheTree(tree, 20))];

        // Act
        const sut = carryExtensions;
        const result = sut(previous, change, 'update', settings);

        // Assert
        const carried = parseCacheTree(result[0]?.data ?? new Uint8Array(), 20);
        expect(carried.entryCount).toBe(-1);
        expect(carried.children[0]?.entryCount).toBe(-1);
      });
    });
  });

  describe('Given a restaged root-level path b', () => {
    describe("When the widened change is carried on an 'update'", () => {
      it('Then the root is invalidated and the sibling directory stays valid', () => {
        // Arrange
        const change = withRestagedPaths(NO_INDEX_CHANGE, [{ path: 'b' as FilePath }]);
        const invalidated = invalidateCacheTree(cacheTree(40), [{ path: 'b' as FilePath }]);

        // Act
        const sut = carryExtensions;
        const result = sut(previousExtensions(), change, 'update', settings);

        // Assert
        expect(result[0]?.data).toEqual(serializeCacheTree(invalidated, 20));
        expect(invalidated.entryCount).toBe(-1);
        expect(invalidated.children[0]?.entryCount).toBe(2);
      });
    });
  });
});

describe('withResolveUndo', () => {
  const BLOB_ID = '1'.repeat(40) as ObjectId;
  const stageOne = (path: string): ResolveUndoRecord => ({
    path: path as FilePath,
    stages: [{ stage: 1, mode: 0o100644, id: BLOB_ID }],
  });
  const carriedTreeAndUntracked = [
    extension('TREE', new Uint8Array([7])),
    extension('UNTR', new Uint8Array([8])),
  ];
  const reucOf = (records: ReadonlyArray<ResolveUndoRecord>) =>
    extension('REUC', serializeResolveUndo(records));
  const recordsOf = (extensions: ReadonlyArray<IndexExtension>) =>
    parseResolveUndo(extensions.find((e) => e.signature === 'REUC')?.data as Uint8Array, 20);

  describe('Given no previous REUC and a resolved record', () => {
    describe('When merging', () => {
      it('Then REUC holds the record between TREE and UNTR', () => {
        // Arrange
        const sut = withResolveUndo;

        // Act
        const result = sut(carriedTreeAndUntracked, [], [stageOne('f')], 20);

        // Assert
        expect(signaturesOf(result)).toEqual(['TREE', 'REUC', 'UNTR']);
        expect(result[1]).toEqual(reucOf([stageOne('f')]));
      });
    });
  });

  describe('Given a previous REUC for h and a resolved f', () => {
    describe('When merging', () => {
      it('Then REUC holds f then h', () => {
        // Arrange
        const sut = withResolveUndo;

        // Act
        const result = sut(carriedTreeAndUntracked, [reucOf([stageOne('h')])], [stageOne('f')], 20);

        // Assert
        expect(recordsOf(result)).toEqual([stageOne('f'), stageOne('h')]);
      });
    });
  });

  describe('Given a malformed previous REUC', () => {
    describe('When merging a resolved f', () => {
      it('Then REUC holds f alone', () => {
        // Arrange
        const sut = withResolveUndo;
        const malformed = extension(
          'REUC',
          new TextEncoder().encode('h\0' + '9\0' + '0\0' + '0\0'),
        );

        // Act
        const result = sut(carriedTreeAndUntracked, [malformed], [stageOne('f')], 20);

        // Assert
        expect(recordsOf(result)).toEqual([stageOne('f')]);
      });
    });
  });

  describe('Given an empty previous REUC', () => {
    describe('When merging a resolved f', () => {
      it('Then REUC holds f alone', () => {
        // Arrange
        const sut = withResolveUndo;

        // Act
        const result = sut(
          carriedTreeAndUntracked,
          [extension('REUC', new Uint8Array())],
          [stageOne('f')],
          20,
        );

        // Assert
        expect(recordsOf(result)).toEqual([stageOne('f')]);
      });
    });
  });

  describe('Given a carried list without REUC and a previous REUC for h', () => {
    describe('When merging a resolved f', () => {
      it('Then REUC holds f then h', () => {
        // Arrange
        const sut = withResolveUndo;

        // Act
        const result = sut(carriedTreeAndUntracked, [reucOf([stageOne('h')])], [stageOne('f')], 20);

        // Assert
        expect(signaturesOf(result)).toEqual(['TREE', 'REUC', 'UNTR']);
        expect(recordsOf(result)).toEqual([stageOne('f'), stageOne('h')]);
      });
    });
  });

  describe('Given no resolved record', () => {
    describe('When merging', () => {
      it('Then the carried list is returned as is', () => {
        // Arrange
        const sut = withResolveUndo;
        const carried = [...carriedTreeAndUntracked, reucOf([stageOne('h')])];

        // Act
        const result = sut(carried, [reucOf([stageOne('x')])], [], 20);

        // Assert
        expect(result).toBe(carried);
      });
    });
  });

  describe('Given a carried list lacking TREE and UNTR', () => {
    describe('When merging a resolved f', () => {
      it('Then only REUC is written', () => {
        // Arrange
        const sut = withResolveUndo;

        // Act
        const result = sut([], [], [stageOne('f')], 20);

        // Assert
        expect(signaturesOf(result)).toEqual(['REUC']);
      });
    });
  });
});
