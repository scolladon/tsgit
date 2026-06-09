import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mergeContent } from '../../../../src/domain/merge/three-way-content.js';
import { arbDisjointThreeWay, arbThreeWay } from './arbitraries.js';

const RUNS = 100;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('region-merge properties', () => {
  describe('Given an arbitrary 3-way input, When merged with favor union', () => {
    it('Then it always resolves clean with no conflict markers', () => {
      // Arrange
      const sut = mergeContent;

      // Act / Assert
      fc.assert(
        fc.property(arbThreeWay(), ({ base, ours, theirs }) => {
          const result = sut(enc(base), enc(ours), enc(theirs), { favor: 'union' });
          expect(result.status).toBe('clean');
          if (result.status === 'clean') {
            expect(dec(result.bytes).includes('<<<<<<<')).toBe(false);
          }
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe('Given disjoint edit scripts, When merged', () => {
    it('Then favor union and favor none produce the same clean bytes', () => {
      // Arrange
      const sut = mergeContent;

      // Act / Assert
      fc.assert(
        fc.property(arbDisjointThreeWay(), ({ base, ours, theirs }) => {
          const union = sut(enc(base), enc(ours), enc(theirs), { favor: 'union' });
          const none = sut(enc(base), enc(ours), enc(theirs));
          expect(none.status).toBe('clean');
          expect(union.status).toBe('clean');
          if (union.status === 'clean' && none.status === 'clean') {
            expect(dec(union.bytes)).toBe(dec(none.bytes));
          }
        }),
        { numRuns: RUNS },
      );
    });
  });
});
