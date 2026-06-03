import { describe, expect, it } from 'vitest';
import { compareCandidates } from '../../../../src/domain/describe/compare-candidates.js';
import type { Candidate } from '../../../../src/domain/describe/types.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';

const candidate = (depth: number, foundOrder: number): Candidate => ({
  name: 'v1',
  commitOid: ObjectId.from('a'.repeat(40)),
  depth,
  foundOrder,
});

describe('compareCandidates', () => {
  describe('Given two candidates of different depth', () => {
    describe('When comparing', () => {
      it('Then the smaller depth sorts first', () => {
        // Arrange
        const near = candidate(1, 5);
        const far = candidate(3, 0);

        // Act
        const sut = compareCandidates(near, far);

        // Assert
        expect(sut).toBeLessThan(0);
      });
    });
  });

  describe('Given two candidates of equal depth', () => {
    describe('When comparing', () => {
      it('Then the earlier foundOrder sorts first', () => {
        // Arrange
        const earlier = candidate(2, 1);
        const later = candidate(2, 4);

        // Act
        const sut = compareCandidates(earlier, later);

        // Assert
        expect(sut).toBeLessThan(0);
      });
    });
  });

  describe('Given two candidates of equal depth and foundOrder', () => {
    describe('When comparing', () => {
      it('Then the result is zero', () => {
        // Arrange
        const a = candidate(2, 3);
        const b = candidate(2, 3);

        // Act
        const sut = compareCandidates(a, b);

        // Assert
        expect(sut).toBe(0);
      });
    });
  });
});
