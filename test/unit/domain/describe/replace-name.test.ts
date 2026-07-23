import { describe, expect, it } from 'vitest';
import { shouldReplaceName } from '../../../../src/domain/describe/replace-name.js';
import type { DescribeName } from '../../../../src/domain/describe/types.js';

const name = (
  priority: DescribeName['priority'],
  taggerDate: number,
  label = 'x',
): DescribeName => ({
  name: label,
  priority,
  taggerDate,
});

type ReplaceNameRow = {
  existingP: DescribeName['priority'];
  existingD: number;
  incomingP: DescribeName['priority'];
  incomingD: number;
  expected: boolean;
  label: string;
};

describe('shouldReplaceName', () => {
  describe('Given an existing and incoming ref of varying priority and tagger date', () => {
    describe('When deciding replacement', () => {
      it.each<ReplaceNameRow>([
        {
          existingP: 1,
          existingD: 0,
          incomingP: 2,
          incomingD: 0,
          expected: true,
          label: 'a higher-priority incoming replaces the existing name',
        },
        {
          existingP: 2,
          existingD: 100,
          incomingP: 0,
          incomingD: 0,
          expected: false,
          label: 'a lower-priority incoming keeps the existing name',
        },
        {
          existingP: 2,
          existingD: 1_000,
          incomingP: 2,
          incomingD: 2_000,
          expected: true,
          label: 'between two annotated tags, the newer tagger date replaces',
        },
        {
          existingP: 2,
          existingD: 2_000,
          incomingP: 2,
          incomingD: 1_000,
          expected: false,
          label: 'between two annotated tags, the existing (newer) name is kept',
        },
        {
          existingP: 2,
          existingD: 1_500,
          incomingP: 2,
          incomingD: 1_500,
          expected: false,
          label:
            'between two annotated tags with equal tagger dates, the first encountered is kept',
        },
        {
          existingP: 1,
          existingD: 0,
          incomingP: 1,
          incomingD: 0,
          expected: false,
          label: 'between two lightweight tags, the first encountered is kept',
        },
        {
          existingP: 1,
          existingD: 100,
          incomingP: 1,
          incomingD: 999,
          expected: false,
          label: 'the tagger date does not decide for non-annotated (lightweight) tags',
        },
        {
          existingP: 2,
          existingD: 100,
          incomingP: 1,
          incomingD: 999,
          expected: false,
          label: 'a newer date never lets a lower priority replace',
        },
      ])('Then $label', ({ existingP, existingD, incomingP, incomingD, expected }) => {
        // Arrange
        const existing = name(existingP, existingD);
        const incoming = name(incomingP, incomingD);

        // Act
        const sut = shouldReplaceName(existing, incoming);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});
