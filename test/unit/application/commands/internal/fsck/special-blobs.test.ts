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
      expect(ledger.queuedNames(BLOB)).toEqual(['.gitmodules']);
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
      expect(ledger.queuedNames(BLOB)).toEqual([]);
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
      expect(ledger.pendingUnder('.gitattributes')).toEqual([BLOB]);
      expect(ledger.pendingUnder('.gitmodules')).toEqual([]);
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
      expect(ledger.pendingUnder('.gitmodules')).toEqual([]);
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
      expect(ledger.pendingUnder('.gitmodules')).toEqual([]);
    });
  });
});

describe.each([
  { name: '.GITMODULES', expected: '.gitmodules' },
  { name: 'gitmod~1', expected: '.gitmodules' },
  { name: 'gi7eba~2', expected: '.gitmodules' },
  { name: '.git‌modules', expected: '.gitmodules' },
  { name: 'a\\.gitmodules', expected: '.gitmodules' },
  { name: 'a\\b\\gitmod~1', expected: '.gitmodules' },
  { name: '.GITATTRIBUTES', expected: '.gitattributes' },
  { name: 'gi7d29~1', expected: '.gitattributes' },
  { name: 'a\\.git‌modules', expected: undefined },
  { name: 'a\\.gitattributes', expected: undefined },
  { name: 'gitmod~5', expected: undefined },
] as const)('Given a regular tree entry named $name', ({ name, expected }) => {
  describe('When the tree is noted', () => {
    it(`Then the blob is queued under ${expected}`, () => {
      // Arrange
      const ledger = sut(cacheWith([treeEntry(FILE_MODE.REGULAR, name, BLOB)]));

      // Act
      ledger.noteTree(TREE);

      // Assert
      expect(ledger.queuedNames(BLOB)).toEqual(expected === undefined ? [] : [expected]);
    });
  });
});

describe.each(['.gitmodules', '.gitattributes', 'a\\.gitmodules'])(
  'Given a symlink tree entry named %s',
  (name) => {
    describe('When the tree is noted', () => {
      it('Then its blob is not queued — git checks the symlink instead', () => {
        // Arrange
        const ledger = sut(cacheWith([treeEntry(FILE_MODE.SYMLINK, name, BLOB)]));

        // Act
        ledger.noteTree(TREE);

        // Assert
        expect(ledger.queuedNames(BLOB)).toEqual([]);
      });
    });
  },
);

describe('Given one blob named .gitattributes by one tree and .gitmodules by another', () => {
  const ATTRIBUTES_TREE = '0000000000000000000000000000000000000006' as ObjectId;
  const ledgerOverBothTrees = () => {
    const ledger = sut(
      new Map<ObjectId, CachedGitObject>([
        [
          ATTRIBUTES_TREE,
          { type: 'tree', entries: [treeEntry(FILE_MODE.REGULAR, '.gitattributes', BLOB)] },
        ],
        [TREE, { type: 'tree', entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', BLOB)] }],
      ]),
    );
    ledger.noteTree(ATTRIBUTES_TREE);
    ledger.noteTree(TREE);
    return ledger;
  };

  describe('When its names are read', () => {
    it("Then it is queued under both, in git's check order", () => {
      // Arrange
      const ledger = ledgerOverBothTrees();

      // Act
      const result = ledger.queuedNames(BLOB);

      // Assert
      expect(result).toEqual(['.gitmodules', '.gitattributes']);
    });
  });

  describe('When its check has run', () => {
    it('Then it is pending under neither name', () => {
      // Arrange
      const ledger = ledgerOverBothTrees();

      // Act
      ledger.markDone(BLOB);

      // Assert
      expect(ledger.pendingUnder('.gitmodules')).toEqual([]);
      expect(ledger.pendingUnder('.gitattributes')).toEqual([]);
    });
  });

  describe('When nothing has checked it', () => {
    it('Then it is pending under each name', () => {
      // Arrange
      const ledger = ledgerOverBothTrees();

      // Act
      const result = [ledger.pendingUnder('.gitmodules'), ledger.pendingUnder('.gitattributes')];

      // Assert
      expect(result).toEqual([[BLOB], [BLOB]]);
    });
  });
});

describe('Given a blob checked under .gitmodules before a later tree names it .gitattributes', () => {
  describe('When the pending blobs are listed', () => {
    it('Then it is still pending under .gitattributes alone', () => {
      // Arrange
      const attributesTree = '0000000000000000000000000000000000000007' as ObjectId;
      const ledger = sut(
        new Map<ObjectId, CachedGitObject>([
          [TREE, { type: 'tree', entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', BLOB)] }],
          [
            attributesTree,
            { type: 'tree', entries: [treeEntry(FILE_MODE.REGULAR, '.gitattributes', BLOB)] },
          ],
        ]),
      );
      ledger.noteTree(TREE);
      ledger.markDone(BLOB);

      // Act
      ledger.noteTree(attributesTree);

      // Assert
      expect(ledger.pendingUnder('.gitmodules')).toEqual([]);
      expect(ledger.pendingUnder('.gitattributes')).toEqual([BLOB]);
    });
  });
});
