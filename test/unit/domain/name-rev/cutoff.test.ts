import { describe, expect, it } from 'vitest';
import { commitIsBeforeCutoff, nameRevCutoff } from '../../../../src/domain/name-rev/cutoff.js';

describe('commitIsBeforeCutoff', () => {
  describe('Given a commit dated below the cutoff', () => {
    describe('When testing', () => {
      it('Then it is before the cutoff', () => {
        // Arrange
        const commitDate = 999;
        const cutoff = 1_000;

        // Act
        const sut = commitIsBeforeCutoff(commitDate, cutoff);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given a commit dated exactly at the cutoff', () => {
    describe('When testing', () => {
      it('Then it is not before the cutoff', () => {
        // Arrange
        const commitDate = 1_000;
        const cutoff = 1_000;

        // Act
        const sut = commitIsBeforeCutoff(commitDate, cutoff);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given a commit dated above the cutoff', () => {
    describe('When testing', () => {
      it('Then it is not before the cutoff', () => {
        // Arrange
        const commitDate = 1_001;
        const cutoff = 1_000;

        // Act
        const sut = commitIsBeforeCutoff(commitDate, cutoff);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('nameRevCutoff', () => {
  describe('Given a normal target date', () => {
    describe('When computing the cutoff', () => {
      it('Then it subtracts one day of slop', () => {
        // Arrange
        const targetDate = 1_000_200_000;

        // Act
        const sut = nameRevCutoff(targetDate);

        // Assert
        expect(sut).toBe(1_000_113_600);
      });
    });
  });

  describe('Given a target dated exactly at the epoch', () => {
    describe('When computing the cutoff', () => {
      it('Then the cutoff stays zero', () => {
        // Arrange
        const targetDate = 0;

        // Act
        const sut = nameRevCutoff(targetDate);

        // Assert
        expect(sut).toBe(0);
      });
    });
  });

  describe('Given a target dated at the representable floor', () => {
    describe('When computing the cutoff', () => {
      it('Then the cutoff clamps to the floor', () => {
        // Arrange
        const targetDate = Number.MIN_SAFE_INTEGER;

        // Act
        const sut = nameRevCutoff(targetDate);

        // Assert
        expect(sut).toBe(Number.MIN_SAFE_INTEGER);
      });
    });
  });

  describe('Given a target dated one second above the floor-plus-slop boundary', () => {
    describe('When computing the cutoff', () => {
      it('Then it takes the subtract branch', () => {
        // Arrange
        const targetDate = Number.MIN_SAFE_INTEGER + 86_400 + 1;

        // Act
        const sut = nameRevCutoff(targetDate);

        // Assert
        expect(sut).toBe(Number.MIN_SAFE_INTEGER + 1);
      });
    });
  });
});
