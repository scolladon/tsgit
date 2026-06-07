import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { matchFuncRec } from '../../../../src/domain/range-diff/funcname.js';

const arbLine = fc.uint8Array({ minLength: 0, maxLength: 200 });

describe('Given an arbitrary byte line', () => {
  describe('When matchFuncRec inspects it', () => {
    it('Then it returns undefined or a heading of at most 80 characters, never throwing', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbLine, (bytes) => {
          const result = matchFuncRec(bytes);
          if (result !== undefined) {
            expect(typeof result).toBe('string');
            expect(result.length).toBeLessThanOrEqual(80);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
