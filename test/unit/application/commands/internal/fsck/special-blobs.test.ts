import { describe, expect, it } from 'vitest';
import { createSpecialBlobLedger } from '../../../../../../src/application/commands/internal/fsck/special-blobs.js';
import { hexToBytes } from '../../../../../../src/domain/objects/encoding.js';
import { SHA1_CONFIG } from '../../../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';

const sut = createSpecialBlobLedger;

const BLOB = '0000000000000000000000000000000000000003' as ObjectId;
const OTHER_BLOB = '0000000000000000000000000000000000000005' as ObjectId;

type RawEntry = readonly [mode: string, name: string, id: ObjectId];

/** A tree body exactly as listed — git's raw entry bytes, in the given order. */
const treeBody = (...entries: ReadonlyArray<RawEntry>): Uint8Array => {
  const encoder = new TextEncoder();
  const parts = entries.flatMap(([mode, name, id]) => [
    encoder.encode(`${mode} ${name}\0`),
    hexToBytes(id),
  ]);
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
};

describe('Given a tree naming one blob .gitattributes and another plainly', () => {
  describe('When the tree is noted', () => {
    it('Then only the special blob is pending, under ".gitattributes"', () => {
      // Arrange
      const ledger = sut(SHA1_CONFIG);

      // Act
      ledger.noteTree(
        treeBody(['100644', '.gitattributes', BLOB], ['100644', 'README', OTHER_BLOB]),
      );

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
      const ledger = sut(SHA1_CONFIG);
      ledger.noteTree(treeBody(['100644', '.gitmodules', BLOB]));

      // Act
      ledger.markDone(BLOB);

      // Assert
      expect(ledger.pendingUnder('.gitmodules')).toEqual([]);
    });
  });
});

describe('Given a tree body whose second entry has a malformed mode', () => {
  describe('When it is noted', () => {
    it('Then the entry before the fault is queued, as git queues before it stops parsing', () => {
      // Arrange
      const ledger = sut(SHA1_CONFIG);

      // Act
      ledger.noteTree(
        treeBody(['100644', '.gitmodules', BLOB], ['10x644', '.gitattributes', BLOB]),
      );

      // Assert
      expect(ledger.queuedNames(BLOB)).toEqual(['.gitmodules']);
    });
  });
});

describe('Given a tree body whose last entry is cut short', () => {
  describe('When it is noted', () => {
    it("Then nothing is queued — git's first decode already refuses a body not ending in a whole entry", () => {
      // Arrange
      const ledger = sut(SHA1_CONFIG);
      const whole = treeBody(['100644', '.gitmodules', BLOB], ['100644', 'zzz', OTHER_BLOB]);

      // Act
      ledger.noteTree(whole.subarray(0, whole.length - 1));

      // Assert
      expect(ledger.queuedNames(BLOB)).toEqual([]);
    });
  });
});

describe('Given a body that cannot be parsed as a tree', () => {
  describe('When it is noted', () => {
    it('Then nothing is queued', () => {
      // Arrange
      const ledger = sut(SHA1_CONFIG);

      // Act
      ledger.noteTree(new TextEncoder().encode('not a tree'));

      // Assert
      expect(ledger.pendingUnder('.gitmodules')).toEqual([]);
    });
  });
});

describe('Given a 32-byte-digest tree naming a .gitmodules blob', () => {
  describe('When a sha256 ledger notes it', () => {
    it('Then the blob is queued under its full sha256 id', () => {
      // Arrange
      const ledger = sut({ algorithm: 'sha256', digestLength: 32, hexLength: 64 });
      const id = `${'ab'.repeat(31)}cd` as ObjectId;

      // Act
      ledger.noteTree(treeBody(['100644', '.gitmodules', id]));

      // Assert
      expect(ledger.pendingUnder('.gitmodules')).toEqual([id]);
    });
  });
});

describe.each([
  { name: '.gitmodules', expected: '.gitmodules' },
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
      const ledger = sut(SHA1_CONFIG);

      // Act
      ledger.noteTree(treeBody(['100644', name, BLOB]));

      // Assert
      expect(ledger.queuedNames(BLOB)).toEqual(expected === undefined ? [] : [expected]);
    });
  });
});

describe.each(['40000', '160000', '100664', '0100644'])(
  'Given a .gitmodules entry of non-symlink mode %s',
  (mode) => {
    describe('When the tree is noted', () => {
      it('Then its object is queued — git queues every non-symlink entry', () => {
        // Arrange
        const ledger = sut(SHA1_CONFIG);

        // Act
        ledger.noteTree(treeBody([mode, '.gitmodules', BLOB]));

        // Assert
        expect(ledger.queuedNames(BLOB)).toEqual(['.gitmodules']);
      });
    });
  },
);

describe.each([
  { mode: '120000', name: '.gitmodules' },
  { mode: '120000', name: '.gitattributes' },
  { mode: '120000', name: 'a\\.gitmodules' },
  { mode: '0120000', name: '.gitmodules' },
  { mode: '120755', name: '.gitmodules' },
  { mode: '1120000', name: '.gitmodules' },
])('Given a $mode tree entry named $name', ({ mode, name }) => {
  describe('When the tree is noted', () => {
    it('Then its blob is not queued — git reads the mode as a symlink and checks that instead', () => {
      // Arrange
      const ledger = sut(SHA1_CONFIG);

      // Act
      ledger.noteTree(treeBody([mode, name, BLOB]));

      // Assert
      expect(ledger.queuedNames(BLOB)).toEqual([]);
    });
  });
});

describe('Given one blob named .gitattributes by one tree and .gitmodules by another', () => {
  const ledgerOverBothTrees = () => {
    const ledger = sut(SHA1_CONFIG);
    ledger.noteTree(treeBody(['100644', '.gitattributes', BLOB]));
    ledger.noteTree(treeBody(['100644', '.gitmodules', BLOB]));
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
      const ledger = sut(SHA1_CONFIG);
      ledger.noteTree(treeBody(['100644', '.gitmodules', BLOB]));
      ledger.markDone(BLOB);

      // Act
      ledger.noteTree(treeBody(['100644', '.gitattributes', BLOB]));

      // Assert
      expect(ledger.pendingUnder('.gitmodules')).toEqual([]);
      expect(ledger.pendingUnder('.gitattributes')).toEqual([BLOB]);
    });
  });
});
