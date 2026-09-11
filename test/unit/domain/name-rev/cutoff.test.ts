import { describe, expect, it } from 'vitest';
import { commitIsBeforeCutoff, nameRevCutoff } from '../../../../src/domain/name-rev/cutoff.js';

const GENERATION_INFINITY = Number.POSITIVE_INFINITY;

describe('commitIsBeforeCutoff', () => {
  describe('Given a commit and a cutoff', () => {
    describe('When testing', () => {
      it.each([
        {
          commit: { committerDate: 999, generation: GENERATION_INFINITY },
          cutoff: { date: 1_000, generation: GENERATION_INFINITY },
          expected: true,
          label:
            'an infinite-generation cutoff falls back to the date test: below the date is before it',
        },
        {
          commit: { committerDate: 1_000, generation: GENERATION_INFINITY },
          cutoff: { date: 1_000, generation: GENERATION_INFINITY },
          expected: false,
          label:
            'an infinite-generation cutoff falls back to the date test: at the date is not before it',
        },
        {
          commit: { committerDate: 1_001, generation: GENERATION_INFINITY },
          cutoff: { date: 1_000, generation: GENERATION_INFINITY },
          expected: false,
          label:
            'an infinite-generation cutoff falls back to the date test: above the date is not before it',
        },
        {
          commit: { committerDate: 5_000, generation: 4 },
          cutoff: { date: 1_000, generation: 5 },
          expected: true,
          label:
            'a finite cutoff generation uses the generation test instead of the date test: below the generation is before it, even with a newer date',
        },
        {
          commit: { committerDate: 5_000, generation: 5 },
          cutoff: { date: 1_000, generation: 5 },
          expected: false,
          label: 'a finite cutoff generation: at the generation is not before it',
        },
        {
          commit: { committerDate: 5_000, generation: 6 },
          cutoff: { date: 1_000, generation: 5 },
          expected: false,
          label: 'a finite cutoff generation: above the generation is not before it',
        },
        {
          commit: { committerDate: 999, generation: GENERATION_INFINITY },
          cutoff: { date: 1_000, generation: 5 },
          expected: false,
          label:
            'a finite cutoff generation: a graph-absent commit carries an infinite generation and is never before it, even with an older date',
        },
      ])('Then $label', ({ commit, cutoff, expected }) => {
        // Arrange + Act
        const result = commitIsBeforeCutoff(commit, cutoff);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('nameRevCutoff', () => {
  describe('Given a target commit', () => {
    describe('When computing the cutoff', () => {
      it.each([
        {
          target: { committerDate: 1_000_200_000, generation: GENERATION_INFINITY },
          expected: { date: 1_000_113_600, generation: GENERATION_INFINITY },
          label: 'subtracts one day of slop from the date and keeps the generation',
        },
        {
          target: { committerDate: 0, generation: GENERATION_INFINITY },
          expected: { date: 0, generation: GENERATION_INFINITY },
          label: 'the date stays zero at the epoch',
        },
        {
          target: { committerDate: Number.MIN_SAFE_INTEGER, generation: GENERATION_INFINITY },
          expected: { date: Number.MIN_SAFE_INTEGER, generation: GENERATION_INFINITY },
          label: 'the date clamps to the floor at the representable floor',
        },
        {
          target: {
            committerDate: Number.MIN_SAFE_INTEGER + 86_400 + 1,
            generation: GENERATION_INFINITY,
          },
          expected: { date: Number.MIN_SAFE_INTEGER + 1, generation: GENERATION_INFINITY },
          label: 'it takes the subtract branch one second above the floor-plus-slop boundary',
        },
        {
          target: { committerDate: 1_000_200_000, generation: 42 },
          expected: { date: 1_000_113_600, generation: 42 },
          label:
            'a finite target generation is carried through unchanged, alongside the slop-adjusted date',
        },
      ])('Then $label', ({ target, expected }) => {
        // Arrange + Act
        const result = nameRevCutoff(target);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
