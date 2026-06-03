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

describe('shouldReplaceName', () => {
  describe('Given an incoming ref of higher priority', () => {
    describe('When deciding replacement', () => {
      it('Then it replaces the existing name', () => {
        // Arrange
        const existing = name(1, 0);
        const incoming = name(2, 0);

        // Act
        const sut = shouldReplaceName(existing, incoming);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given an incoming ref of lower priority', () => {
    describe('When deciding replacement', () => {
      it('Then the existing name is kept', () => {
        // Arrange
        const existing = name(2, 100);
        const incoming = name(0, 0);

        // Act
        const sut = shouldReplaceName(existing, incoming);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given two annotated tags on one commit, the incoming newer', () => {
    describe('When deciding replacement', () => {
      it('Then the newer tagger date replaces', () => {
        // Arrange
        const existing = name(2, 1_000);
        const incoming = name(2, 2_000);

        // Act
        const sut = shouldReplaceName(existing, incoming);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given two annotated tags on one commit, the incoming older', () => {
    describe('When deciding replacement', () => {
      it('Then the existing (newer) name is kept', () => {
        // Arrange
        const existing = name(2, 2_000);
        const incoming = name(2, 1_000);

        // Act
        const sut = shouldReplaceName(existing, incoming);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given two annotated tags on one commit with equal tagger dates', () => {
    describe('When deciding replacement', () => {
      it('Then the first encountered is kept', () => {
        // Arrange
        const existing = name(2, 1_500);
        const incoming = name(2, 1_500);

        // Act
        const sut = shouldReplaceName(existing, incoming);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given two lightweight tags on one commit', () => {
    describe('When deciding replacement', () => {
      it('Then the first encountered is kept', () => {
        // Arrange
        const existing = name(1, 0);
        const incoming = name(1, 0);

        // Act
        const sut = shouldReplaceName(existing, incoming);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});
