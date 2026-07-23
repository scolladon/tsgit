import { describe, expect, it } from 'vitest';
import { commitIsBeforeCutoff, nameRevCutoff } from '../../../../src/domain/name-rev/cutoff.js';

describe('commitIsBeforeCutoff', () => {
  describe('Given a commit date and a cutoff', () => {
    describe('When testing', () => {
      it.each([
        {
          commitDate: 999,
          cutoff: 1_000,
          expected: true,
          label: 'a date below the cutoff is before it',
        },
        {
          commitDate: 1_000,
          cutoff: 1_000,
          expected: false,
          label: 'a date exactly at the cutoff is not before it',
        },
        {
          commitDate: 1_001,
          cutoff: 1_000,
          expected: false,
          label: 'a date above the cutoff is not before it',
        },
      ])('Then $label', ({ commitDate, cutoff, expected }) => {
        // Arrange + Act
        const sut = commitIsBeforeCutoff(commitDate, cutoff);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});

describe('nameRevCutoff', () => {
  describe('Given a target date', () => {
    describe('When computing the cutoff', () => {
      it.each([
        { targetDate: 1_000_200_000, expected: 1_000_113_600, label: 'subtracts one day of slop' },
        { targetDate: 0, expected: 0, label: 'the cutoff stays zero at the epoch' },
        {
          targetDate: Number.MIN_SAFE_INTEGER,
          expected: Number.MIN_SAFE_INTEGER,
          label: 'the cutoff clamps to the floor at the representable floor',
        },
        {
          targetDate: Number.MIN_SAFE_INTEGER + 86_400 + 1,
          expected: Number.MIN_SAFE_INTEGER + 1,
          label: 'it takes the subtract branch one second above the floor-plus-slop boundary',
        },
      ])('Then $label', ({ targetDate, expected }) => {
        // Arrange + Act
        const sut = nameRevCutoff(targetDate);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});
