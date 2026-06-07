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
  describe('Given an existing non-tag and an incoming tag', () => {
    describe('When deciding replacement', () => {
      it('Then the tag wins', () => {
        // Arrange
        const existing = rev(false, 1, 0);
        const incoming = rev(true, 5, 0);

        // Act
        const sut = isBetterName(existing, incoming);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given an existing tag and an incoming non-tag', () => {
    describe('When deciding replacement', () => {
      it('Then the existing tag is kept', () => {
        // Arrange
        const existing = rev(true, 5, 0);
        const incoming = rev(false, 1, 0);

        // Act
        const sut = isBetterName(existing, incoming);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given equal tag-ness and an incoming nearer name', () => {
    describe('When deciding replacement', () => {
      it('Then the nearer name wins', () => {
        // Arrange
        const existing = rev(true, 4, 0);
        const incoming = rev(true, 2, 0);

        // Act
        const sut = isBetterName(existing, incoming);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given equal tag-ness and an incoming farther name', () => {
    describe('When deciding replacement', () => {
      it('Then the existing nearer name is kept', () => {
        // Arrange
        const existing = rev(true, 2, 0);
        const incoming = rev(true, 4, 0);

        // Act
        const sut = isBetterName(existing, incoming);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given equal tag-ness and distance, the incoming tagged older', () => {
    describe('When deciding replacement', () => {
      it('Then the older-tagged name wins', () => {
        // Arrange
        const existing = rev(true, 3, 2_000);
        const incoming = rev(true, 3, 1_000);

        // Act
        const sut = isBetterName(existing, incoming);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given equal tag-ness and distance, the incoming tagged newer', () => {
    describe('When deciding replacement', () => {
      it('Then the existing older-tagged name is kept', () => {
        // Arrange
        const existing = rev(true, 3, 1_000);
        const incoming = rev(true, 3, 2_000);

        // Act
        const sut = isBetterName(existing, incoming);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given two names equal in tag-ness, distance and tagger date', () => {
    describe('When deciding replacement', () => {
      it('Then the existing name is kept', () => {
        // Arrange
        const existing = rev(true, 3, 1_000);
        const incoming = rev(true, 3, 1_000);

        // Act
        const sut = isBetterName(existing, incoming);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given an existing nearer non-tag and an incoming farther tag', () => {
    describe('When deciding replacement', () => {
      it('Then the tag wins despite the larger distance', () => {
        // Arrange
        const existing = rev(false, 1, 0);
        const incoming = rev(true, 9, 0);

        // Act
        const sut = isBetterName(existing, incoming);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});
