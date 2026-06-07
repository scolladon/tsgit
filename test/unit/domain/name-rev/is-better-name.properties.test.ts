import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isBetterName } from '../../../../src/domain/name-rev/is-better-name.js';
import type { RevName } from '../../../../src/domain/name-rev/types.js';
import { revNameArb } from './arbitraries.js';

const withTag = (name: RevName, fromTag: boolean): RevName => ({ ...name, fromTag });

describe('Given two names that differ only in tag-ness', () => {
  describe('When comparing with isBetterName', () => {
    it('Then a tag always beats a non-tag regardless of distance', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(revNameArb, revNameArb, (a, b) => {
          const nonTag = withTag(a, false);
          const tag = withTag(b, true);
          expect(isBetterName(nonTag, tag)).toBe(true);
          expect(isBetterName(tag, nonTag)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an arbitrary name compared with itself', () => {
  describe('When comparing with isBetterName', () => {
    it('Then it is never better than itself (irreflexive)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(revNameArb, (sut) => {
          expect(isBetterName(sut, sut)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given two arbitrary names', () => {
  describe('When comparing both directions with isBetterName', () => {
    it('Then at most one direction is better (asymmetric)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(revNameArb, revNameArb, (a, b) => {
          expect(isBetterName(a, b) && isBetterName(b, a)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });
});
