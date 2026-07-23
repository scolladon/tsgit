import { describe, expect, it } from 'vitest';
import { isBetterName } from '../../../../src/domain/name-rev/is-better-name.js';
import type { RevName } from '../../../../src/domain/name-rev/types.js';

const rev = (fromTag: boolean, distance: number, taggerDate: number): RevName => ({
  ref: 'refs/x' as RevName['ref'],
  tagDeref: false,
  fromTag,
  taggerDate,
  generation: 0,
  distance,
  steps: [],
});

describe('isBetterName', () => {
  describe('Given an existing and incoming name of varying tag-ness, distance and tagger date', () => {
    describe('When deciding replacement', () => {
      it.each([
        {
          existingFromTag: false,
          existingDistance: 1,
          existingDate: 0,
          incomingFromTag: true,
          incomingDistance: 5,
          incomingDate: 0,
          expected: true,
          label: 'an incoming tag wins over an existing non-tag',
        },
        {
          existingFromTag: true,
          existingDistance: 5,
          existingDate: 0,
          incomingFromTag: false,
          incomingDistance: 1,
          incomingDate: 0,
          expected: false,
          label: 'the existing tag is kept over an incoming non-tag',
        },
        {
          existingFromTag: true,
          existingDistance: 4,
          existingDate: 0,
          incomingFromTag: true,
          incomingDistance: 2,
          incomingDate: 0,
          expected: true,
          label: 'with equal tag-ness, the nearer incoming name wins',
        },
        {
          existingFromTag: true,
          existingDistance: 2,
          existingDate: 0,
          incomingFromTag: true,
          incomingDistance: 4,
          incomingDate: 0,
          expected: false,
          label: 'with equal tag-ness, the existing nearer name is kept',
        },
        {
          existingFromTag: true,
          existingDistance: 3,
          existingDate: 2_000,
          incomingFromTag: true,
          incomingDistance: 3,
          incomingDate: 1_000,
          expected: true,
          label: 'with equal tag-ness and distance, the older-tagged incoming wins',
        },
        {
          existingFromTag: true,
          existingDistance: 3,
          existingDate: 1_000,
          incomingFromTag: true,
          incomingDistance: 3,
          incomingDate: 2_000,
          expected: false,
          label: 'with equal tag-ness and distance, the existing older-tagged name is kept',
        },
        {
          existingFromTag: true,
          existingDistance: 3,
          existingDate: 1_000,
          incomingFromTag: true,
          incomingDistance: 3,
          incomingDate: 1_000,
          expected: false,
          label: 'a full tie (tag-ness, distance and tagger date) keeps the existing name',
        },
        {
          existingFromTag: false,
          existingDistance: 1,
          existingDate: 0,
          incomingFromTag: true,
          incomingDistance: 9,
          incomingDate: 0,
          expected: true,
          label: 'a tag wins despite a larger distance',
        },
      ])(
        'Then $label',
        ({
          existingFromTag,
          existingDistance,
          existingDate,
          incomingFromTag,
          incomingDistance,
          incomingDate,
          expected,
        }) => {
          // Arrange
          const existing = rev(existingFromTag, existingDistance, existingDate);
          const incoming = rev(incomingFromTag, incomingDistance, incomingDate);

          // Act
          const sut = isBetterName(existing, incoming);

          // Assert
          expect(sut).toBe(expected);
        },
      );
    });
  });
});
