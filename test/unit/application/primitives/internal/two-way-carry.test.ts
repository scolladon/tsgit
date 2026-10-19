import { describe, expect, it } from 'vitest';

import { carryStagedChanges } from '../../../../../src/application/primitives/internal/two-way-carry.js';
import { indexPathKey } from '../../../../../src/domain/git-index/index-path-key.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';

const BLOB_A = 'a'.repeat(40) as ObjectId;
const BLOB_B = 'b'.repeat(40) as ObjectId;
const BLOB_C = 'c'.repeat(40) as ObjectId;

const version = (id: ObjectId, mode: string = FILE_MODE.REGULAR) => ({
  path: 'f' as FilePath,
  id,
  mode: mode as typeof FILE_MODE.REGULAR,
});

const KEY = indexPathKey(version(BLOB_A));

describe('carryStagedChanges', () => {
  describe('Given HEAD and the target hold the same blob and mode', () => {
    describe('When the index holds another blob', () => {
      it('Then the path is kept and nothing is refused', () => {
        // Arrange
        const sut = carryStagedChanges;

        // Act
        const result = sut([version(BLOB_A)], [version(BLOB_A)], [version(BLOB_B)]);

        // Assert
        expect(result.kept.has(KEY)).toBe(true);
        expect(result.refused).toEqual([]);
      });
    });
  });

  describe('Given HEAD and the target differ by blob only', () => {
    describe('When the index holds a third blob', () => {
      it('Then the path is not kept and is refused', () => {
        // Arrange
        const sut = carryStagedChanges;

        // Act
        const result = sut([version(BLOB_A)], [version(BLOB_B)], [version(BLOB_C)]);

        // Assert
        expect(result.kept.has(KEY)).toBe(false);
        expect(result.refused).toEqual(['f']);
      });
    });
  });

  describe('Given HEAD and the target differ by mode only', () => {
    describe('When the index equals HEAD', () => {
      it('Then the path is not kept and is not refused', () => {
        // Arrange
        const sut = carryStagedChanges;

        // Act
        const result = sut(
          [version(BLOB_A)],
          [version(BLOB_A, FILE_MODE.EXECUTABLE)],
          [version(BLOB_A)],
        );

        // Assert
        expect(result.kept.has(KEY)).toBe(false);
        expect(result.refused).toEqual([]);
      });
    });

    describe('When the index holds a third mode', () => {
      it('Then the path is refused', () => {
        // Arrange
        const sut = carryStagedChanges;

        // Act
        const result = sut(
          [version(BLOB_A)],
          [version(BLOB_A, FILE_MODE.EXECUTABLE)],
          [version(BLOB_A, FILE_MODE.SYMLINK)],
        );

        // Assert
        expect(result.kept.has(KEY)).toBe(false);
        expect(result.refused).toEqual(['f']);
      });
    });
  });

  describe('Given the path is absent from HEAD only', () => {
    describe('When the target adds it and the index holds another blob', () => {
      it('Then the path is refused', () => {
        // Arrange
        const sut = carryStagedChanges;

        // Act
        const result = sut([], [version(BLOB_A)], [version(BLOB_B)]);

        // Assert
        expect(result.kept.has(KEY)).toBe(false);
        expect(result.refused).toEqual(['f']);
      });
    });
  });

  describe('Given the path is absent from the target only', () => {
    describe('When the index still holds the HEAD version', () => {
      it('Then the path is neither kept nor refused', () => {
        // Arrange
        const sut = carryStagedChanges;

        // Act
        const result = sut([version(BLOB_A)], [], [version(BLOB_A)]);

        // Assert
        expect(result.kept.has(KEY)).toBe(false);
        expect(result.refused).toEqual([]);
      });
    });
  });
});
