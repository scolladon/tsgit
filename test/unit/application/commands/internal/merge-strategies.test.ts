import { describe, expect, it } from 'vitest';
import {
  conflictWeight,
  explicitStrategies,
  preferConflict,
} from '../../../../../src/application/commands/internal/merge-strategies.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { MergeConflict } from '../../../../../src/domain/merge/index.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';

const id = 'a'.repeat(40) as ObjectId;
const conflict = (sides: Partial<MergeConflict>): MergeConflict => ({
  type: 'content',
  path: 'f' as FilePath,
  ...sides,
});

describe('conflictWeight', () => {
  describe('Given a content conflict and a modify/delete conflict', () => {
    describe('When weighed', () => {
      it("Then each path counts once plus once per index stage, as git's evaluate_result", () => {
        // Arrange
        const conflicts = [
          conflict({ baseId: id, ourId: id, theirId: id }),
          conflict({ baseId: id, ourId: id }),
        ];
        const sut = conflictWeight;

        // Act
        const result = sut(conflicts);

        // Assert
        expect(result).toBe(4 + 3);
      });
    });
  });
});

describe('preferConflict', () => {
  describe.each([
    ['no conflict yet', undefined, 5, 'tried'],
    ['a heavier one', 6, 5, 'tried'],
    ['an equally heavy one', 5, 5, 'tried'],
    ['a lighter one', 4, 5, 'best'],
  ] as const)('Given %s kept', (_label, bestWeight, triedWeight, expected) => {
    describe('When a conflicting strategy is tried', () => {
      it(`Then the ${expected} one is kept`, () => {
        // Arrange
        const best = bestWeight === undefined ? undefined : { weight: bestWeight, name: 'best' };
        const tried = { weight: triedWeight, name: 'tried' };
        const sut = preferConflict;

        // Act
        const result = sut(best, tried);

        // Assert
        expect(result.name).toBe(expected);
      });
    });
  });
});

describe('explicitStrategies', () => {
  describe('Given a single known strategy name', () => {
    describe('When listed', () => {
      it('Then it is the one-element list', () => {
        // Arrange
        const sut = explicitStrategies;

        // Act
        const result = sut('ours');

        // Assert
        expect(result).toEqual(['ours']);
      });
    });
  });

  describe('Given a single unknown strategy name', () => {
    describe('When listed', () => {
      it("Then it refuses with git's available strategies", () => {
        // Arrange
        const sut = explicitStrategies;

        // Act
        const attempt = (): unknown => sut('bogus');

        // Assert
        try {
          attempt();
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data).toEqual({
            code: 'UNKNOWN_MERGE_STRATEGY',
            strategy: 'bogus',
            available: ['octopus', 'ours', 'recursive', 'resolve', 'subtree'],
          });
        }
      });
    });
  });
});
