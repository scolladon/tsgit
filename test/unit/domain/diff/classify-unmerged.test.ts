import { describe, expect, it } from 'vitest';
import {
  type ConflictKind,
  classifyUnmerged,
  type UnmergedEntryGroup,
} from '../../../../src/domain/diff/index.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index.js';

// The classifier only inspects stage presence, so a sentinel entry suffices.
const STAGE = {} as IndexEntry;

const group = (s1: boolean, s2: boolean, s3: boolean): UnmergedEntryGroup => ({
  ...(s1 ? { stage1: STAGE } : {}),
  ...(s2 ? { stage2: STAGE } : {}),
  ...(s3 ? { stage3: STAGE } : {}),
});

// One row per non-empty subset of {base, ours, theirs} → its git conflict state.
const cases: ReadonlyArray<{
  readonly s1: boolean;
  readonly s2: boolean;
  readonly s3: boolean;
  readonly expected: ConflictKind;
}> = [
  { s1: true, s2: true, s3: true, expected: 'both-modified' }, // UU
  { s1: false, s2: true, s3: true, expected: 'both-added' }, // AA
  { s1: true, s2: false, s3: false, expected: 'both-deleted' }, // DD
  { s1: false, s2: true, s3: false, expected: 'added-by-us' }, // AU
  { s1: false, s2: false, s3: true, expected: 'added-by-them' }, // UA
  { s1: true, s2: false, s3: true, expected: 'deleted-by-us' }, // DU
  { s1: true, s2: true, s3: false, expected: 'deleted-by-them' }, // UD
];

describe('classifyUnmerged', () => {
  describe('Given an unmerged entry group', () => {
    describe('When classifying its stage presence', () => {
      it.each(cases)('Then stages {1:$s1, 2:$s2, 3:$s3} classify as $expected', ({
        s1,
        s2,
        s3,
        expected,
      }) => {
        // Arrange
        const sut = group(s1, s2, s3);

        // Act
        const result = classifyUnmerged(sut);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
