import { describe, expect, it } from 'vitest';

import { indexRuleEntries } from '../../../../../src/application/primitives/internal/index-rule-entries.js';

type Stage = 0 | 1 | 2 | 3;

const entry = (path: string, stage: Stage) => ({ path, flags: { stage } });

describe('indexRuleEntries', () => {
  describe.each([
    { title: 'stage 0 listed first', stages: [0, 2] as Stage[], expected: 0 },
    { title: 'stage 0 listed last', stages: [2, 0] as Stage[], expected: 0 },
    { title: 'only stages 1, 2 and 3', stages: [1, 2, 3] as Stage[], expected: 2 },
    { title: 'stage 3 listed after stage 2', stages: [2, 3] as Stage[], expected: 2 },
    { title: 'stage 2 listed after stage 2', stages: [2, 2] as Stage[], expected: 2 },
  ])('Given one path with $title', ({ stages, expected }) => {
    describe('When selecting the index rule entries', () => {
      it('Then the entry of stage 0, else stage 2, is kept', () => {
        // Arrange
        const sut = indexRuleEntries;

        // Act
        const result = sut(stages.map((stage) => entry('f', stage)));

        // Assert
        expect(result.map((kept) => kept.flags.stage)).toEqual([expected]);
      });
    });
  });

  describe('Given a path recorded only at stages 1 and 3', () => {
    describe('When selecting the index rule entries', () => {
      it('Then the path is absent', () => {
        // Arrange
        const sut = indexRuleEntries;

        // Act
        const result = sut([entry('f', 1), entry('f', 3)]);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given two distinct paths', () => {
    describe('When selecting the index rule entries', () => {
      it('Then each keeps its own entry', () => {
        // Arrange
        const sut = indexRuleEntries;

        // Act
        const result = sut([entry('a', 2), entry('b', 0)]);

        // Assert
        expect(result.map((kept) => kept.path)).toEqual(['a', 'b']);
      });
    });
  });
});
