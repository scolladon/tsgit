import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tagNameMatches } from '../../../../src/domain/describe/match.js';
import { arbTagName } from './arbitraries.js';

describe('tagNameMatches properties', () => {
  describe('Given no include patterns and an arbitrary name', () => {
    describe('When matching with no excludes', () => {
      it('Then every name is included (identity)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbTagName(), (name) => {
            expect(tagNameMatches(name, [], [])).toBe(true);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary name and the exact name as an exclude pattern', () => {
    describe('When matching', () => {
      it('Then it flips an otherwise-included name to excluded', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbTagName(), (name) => {
            // Pre: the name is included absent any exclude.
            expect(tagNameMatches(name, [], [])).toBe(true);
            // Appending the literal name as an exclude drops it.
            expect(tagNameMatches(name, [], [name])).toBe(false);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
