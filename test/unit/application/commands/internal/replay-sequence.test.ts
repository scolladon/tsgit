import { describe, expect, it } from 'vitest';

import { toConflictList } from '../../../../../src/application/commands/internal/replay-sequence.js';
import type { MergeConflict } from '../../../../../src/domain/merge/index.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';

const conflictAt = (path: string): MergeConflict => ({ type: 'content', path: path as FilePath });

describe('toConflictList', () => {
  describe('Given a conflict at a path holding a lone escape', () => {
    describe('When mapping to the public list', () => {
      it('Then the path is its replacement-character view', () => {
        // Arrange
        const conflicts = [conflictAt('\uDCFF.txt')];

        // Act
        const result = toConflictList(conflicts);

        // Assert
        expect(result).toEqual([{ path: '�.txt', type: 'content' }]);
      });
    });
  });

  describe('Given a conflict at a well-formed path', () => {
    describe('When mapping to the public list', () => {
      it('Then the path is unchanged', () => {
        // Arrange
        const conflicts = [conflictAt('a/é.txt')];

        // Act
        const result = toConflictList(conflicts);

        // Assert
        expect(result).toEqual([{ path: 'a/é.txt', type: 'content' }]);
      });
    });
  });
});
