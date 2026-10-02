import { describe, expect, it } from 'vitest';
import type { CachedGitObject } from '../../../../../../src/application/commands/internal/fsck/object-cache.js';
import { createSpecialBlobLedger } from '../../../../../../src/application/commands/internal/fsck/special-blobs.js';
import type { ObjectId, TreeEntry } from '../../../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../../src/domain/objects/tree.js';

const sut = createSpecialBlobLedger;

const BLOB = '0000000000000000000000000000000000000003' as ObjectId;
const OTHER_BLOB = '0000000000000000000000000000000000000005' as ObjectId;
const TREE = '0000000000000000000000000000000000000004' as ObjectId;

const cacheWith = (entries: ReadonlyArray<TreeEntry>): ReadonlyMap<ObjectId, CachedGitObject> =>
  new Map<ObjectId, CachedGitObject>([[TREE, { type: 'tree', entries }]]);

describe('Given a tree entry whose nameBytes are ".gitmodules" but whose decoded name disagrees', () => {
  describe('When the tree is noted', () => {
    it('Then the blob is queued under ".gitmodules" — the decision reads nameBytes', () => {
      // Arrange
      const real = treeEntry(FILE_MODE.REGULAR, '.gitmodules', BLOB);
      const ledger = sut(cacheWith([{ ...real, name: 'config.txt' } as TreeEntry]));

      // Act
      ledger.noteTree(TREE);

      // Assert
      expect(ledger.queuedName(BLOB)).toBe('.gitmodules');
    });
  });
});

describe('Given a tree entry whose decoded name reads ".gitmodules" but whose nameBytes disagree', () => {
  describe('When the tree is noted', () => {
    it('Then the blob is not queued', () => {
      // Arrange
      const real = treeEntry(FILE_MODE.REGULAR, 'config.txt', BLOB);
      const ledger = sut(cacheWith([{ ...real, name: '.gitmodules' } as TreeEntry]));

      // Act
      ledger.noteTree(TREE);

      // Assert
      expect(ledger.queuedName(BLOB)).toBeUndefined();
    });
  });
});

describe('Given a tree naming one blob .gitattributes and another plainly', () => {
  describe('When the tree is noted', () => {
    it('Then only the special blob is pending, under ".gitattributes"', () => {
      // Arrange
      const ledger = sut(
        cacheWith([
          treeEntry(FILE_MODE.REGULAR, '.gitattributes', BLOB),
          treeEntry(FILE_MODE.REGULAR, 'README', OTHER_BLOB),
        ]),
      );

      // Act
      ledger.noteTree(TREE);

      // Assert
      expect(ledger.pending()).toEqual(new Map([[BLOB, '.gitattributes']]));
    });
  });
});

describe('Given a queued blob whose check has run', () => {
  describe('When the pending blobs are listed', () => {
    it('Then the done blob is no longer pending', () => {
      // Arrange
      const ledger = sut(cacheWith([treeEntry(FILE_MODE.REGULAR, '.gitmodules', BLOB)]));
      ledger.noteTree(TREE);

      // Act
      ledger.markDone(BLOB);

      // Assert
      expect(ledger.pending()).toEqual(new Map());
    });
  });
});

describe('Given an id the object cache does not hold as a tree', () => {
  describe('When it is noted', () => {
    it('Then nothing is queued', () => {
      // Arrange
      const ledger = sut(new Map<ObjectId, CachedGitObject>([[TREE, null]]));

      // Act
      ledger.noteTree(TREE);

      // Assert
      expect(ledger.pending()).toEqual(new Map());
    });
  });
});
