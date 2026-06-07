import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { matchRefGlob } from '../../../../src/domain/name-rev/ref-pattern.js';

const asciiArb = fc.string({ minLength: 0, maxLength: 12 });
const literalArb = fc.stringMatching(/^[a-z/0-9-]{0,12}$/);

describe('Given any ASCII pattern and ref', () => {
  describe('When matching with matchRefGlob', () => {
    it('Then it never throws', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(asciiArb, asciiArb, (pattern, ref) => {
          expect(() => matchRefGlob(pattern, ref)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an all-`*` pattern', () => {
  describe('When matching any ref', () => {
    it('Then it matches everything', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(asciiArb, (ref) => {
          expect(matchRefGlob('*', ref)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a metacharacter-free literal pattern', () => {
  describe('When matching a ref', () => {
    it('Then it matches iff the ref is identical', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(literalArb, literalArb, (pattern, ref) => {
          expect(matchRefGlob(pattern, ref)).toBe(pattern === ref);
        }),
        { numRuns: 50 },
      );
    });
  });
});
