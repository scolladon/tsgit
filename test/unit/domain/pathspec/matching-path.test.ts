import { describe, expect, it } from 'vitest';
import {
  type IndexPath,
  indexPathOfBytes,
} from '../../../../src/domain/git-index/index-path-key.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import {
  matchesIndexPath,
  matchesUnmergedIndexPath,
} from '../../../../src/domain/pathspec/matching-path.js';

const LOSSY: IndexPath = {
  path: '�.txt' as FilePath,
  pathBytes: Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74),
};
const UTF8: IndexPath = { path: '�.txt' as FilePath };
const NESTED_LOSSY: IndexPath = {
  path: 'd/�' as FilePath,
  pathBytes: Uint8Array.of(0x64, 0x2f, 0xff),
};

describe('matchesIndexPath', () => {
  describe('Given a literal spec spelled with U+FFFD', () => {
    describe('When matched against the lossy entry', () => {
      it('Then the verdict is false', () => {
        // Arrange
        const spec = compilePathspec(['�.txt']);

        const sut = matchesIndexPath;

        // Act
        const result = sut(spec, LOSSY);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When matched against the UTF-8 twin', () => {
      it('Then the verdict is true', () => {
        // Arrange
        const spec = compilePathspec(['�.txt']);

        const sut = matchesIndexPath;

        // Act
        const result = sut(spec, UTF8);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a star glob', () => {
    describe('When matched against the lossy entry and its twin', () => {
      it('Then both match', () => {
        // Arrange
        const spec = compilePathspec(['*.txt']);

        const sut = matchesIndexPath;

        // Act
        const result = [sut(spec, LOSSY), sut(spec, UTF8)];

        // Assert
        expect(result).toEqual([true, true]);
      });
    });
  });

  describe('Given a question-mark glob', () => {
    describe('When matched against the lossy entry', () => {
      it('Then one invalid byte counts as one character', () => {
        // Arrange
        const spec = compilePathspec(['?.txt']);

        const sut = matchesIndexPath;

        // Act
        const result = sut(spec, LOSSY);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a directory prefix', () => {
    describe('When matched against a lossy entry beneath it', () => {
      it('Then the verdict is true', () => {
        // Arrange
        const spec = compilePathspec(['d']);

        const sut = matchesIndexPath;

        // Act
        const result = sut(spec, NESTED_LOSSY);

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});

describe('matchesUnmergedIndexPath', () => {
  describe('Given a lossy entry held at three stages', () => {
    describe('When matched through its escaped view', () => {
      it('Then a covering directory spec matches and a foreign one does not', () => {
        // Arrange
        const entry = indexPathOfBytes(Uint8Array.of(0x64, 0x2f, 0xff));
        const sut = matchesUnmergedIndexPath;

        // Act
        const covered = sut(compilePathspec(['d']), entry, 3);
        const foreign = sut(compilePathspec(['e']), entry, 3);

        // Assert
        expect(covered).toBe(true);
        expect(foreign).toBe(false);
      });
    });
  });

  describe('Given a plain entry', () => {
    describe('When one stage exists and an exact exclusion follows the dot', () => {
      it('Then the verdict is false', () => {
        // Arrange
        const spec = compilePathspec(['', '!f']);
        const sut = matchesUnmergedIndexPath;

        // Act
        const result = sut(spec, { path: 'f' as FilePath }, 1);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When three stages exist and an exact exclusion follows the dot', () => {
      it('Then the verdict is true', () => {
        // Arrange
        const spec = compilePathspec(['', '!f']);
        const sut = matchesUnmergedIndexPath;

        // Act
        const result = sut(spec, { path: 'f' as FilePath }, 3);

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});
