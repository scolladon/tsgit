import { describe, expect, it } from 'vitest';
import { unmergedModeDonor } from '../../../../src/domain/git-index/unmerged-mode-donor.js';
import type { FileMode } from '../../../../src/domain/objects/index.js';

const BASE = { mode: '100644' as FileMode };
const OURS = { mode: '100755' as FileMode };
const THEIRS = { mode: '120000' as FileMode };

describe('unmergedModeDonor', () => {
  describe.each([
    { label: 'ours alone', stages: { stage2: OURS }, expected: '100755' },
    { label: 'base and ours', stages: { stage1: BASE, stage2: OURS }, expected: '100755' },
    { label: 'base and theirs', stages: { stage1: BASE, stage3: THEIRS }, expected: '100644' },
    { label: 'theirs alone', stages: { stage3: THEIRS }, expected: '120000' },
    {
      label: 'base, ours and theirs',
      stages: { stage1: BASE, stage2: OURS, stage3: THEIRS },
      expected: '100755',
    },
    { label: 'no stage', stages: {}, expected: undefined },
  ])('Given $label', ({ stages, expected }) => {
    describe('When unmergedModeDonor', () => {
      it(`Then ${String(expected)}`, () => {
        // Arrange
        const sut = unmergedModeDonor;

        // Act
        const result = sut(stages);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
