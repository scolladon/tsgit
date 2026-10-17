import { describe, expect, it } from 'vitest';
import { stage0Entry } from '../../../../../src/application/primitives/internal/synthetic-index-entry.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/index.js';

const ID = 'a'.repeat(40) as ObjectId;

describe('stage0Entry', () => {
  describe('Given a path carrying an escaped byte', () => {
    describe('When stage0Entry builds the entry', () => {
      it('Then path is the U+FFFD view and pathBytes the raw bytes', () => {
        // Arrange
        const path = '\uDCFF.txt' as FilePath;

        // Act
        const result = stage0Entry(path, ID, FILE_MODE.REGULAR);

        // Assert
        expect(result.path).toBe('\uFFFD.txt');
        expect(Array.from(result.pathBytes ?? [])).toEqual([0xff, 0x2e, 0x74, 0x78, 0x74]);
      });
    });
  });

  describe('Given a well-formed path', () => {
    describe('When stage0Entry builds the entry', () => {
      it('Then the entry has no pathBytes key', () => {
        // Arrange
        const path = 'a' as FilePath;

        // Act
        const result = stage0Entry(path, ID, FILE_MODE.REGULAR);

        // Assert
        expect(result.path).toBe('a');
        expect('pathBytes' in result).toBe(false);
      });
    });
  });
});
