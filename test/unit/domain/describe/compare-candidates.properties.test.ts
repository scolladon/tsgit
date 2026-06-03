import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareCandidates } from '../../../../src/domain/describe/compare-candidates.js';
import { arbCandidate } from './arbitraries.js';

const sign = (n: number): number => Math.sign(n);

describe('compareCandidates properties', () => {
  describe('Given an arbitrary candidate compared with itself', () => {
    describe('When compareCandidates is called', () => {
      it('Then the result is zero (reflexive)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCandidate(), (c) => {
            expect(compareCandidates(c, c)).toBe(0);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given two arbitrary candidates', () => {
    describe('When compareCandidates is called in both orders', () => {
      it('Then the signs are antisymmetric', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCandidate(), arbCandidate(), (a, b) => {
            expect(sign(compareCandidates(a, b))).toBe(-sign(compareCandidates(b, a)));
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given two candidates of strictly different depth', () => {
    describe('When compareCandidates is called', () => {
      it('Then depth dominates foundOrder', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbCandidate(),
            arbCandidate(),
            fc.nat({ max: 100 }),
            fc.nat({ max: 100 }),
            (a, b, fa, fb) => {
              fc.pre(a.depth !== b.depth);
              const near = { ...a, depth: Math.min(a.depth, b.depth), foundOrder: fa };
              const far = { ...b, depth: Math.max(a.depth, b.depth), foundOrder: fb };
              expect(compareCandidates(near, far)).toBeLessThan(0);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
