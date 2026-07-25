import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cleanShortlogSubject } from '../../../../src/domain/shortlog/clean-subject.js';
import { arbShortlogMessage } from './arbitraries.js';

const RUNS = 200;

describe('cleanShortlogSubject properties', () => {
  describe('Given an arbitrary message, When cleaned', () => {
    it('Then it never throws', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbShortlogMessage(), (message) => {
          expect(() => cleanShortlogSubject(message)).not.toThrow();
        }),
        { numRuns: RUNS },
      );
    });

    it('Then the result is a single line', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbShortlogMessage(), (message) => {
          expect(cleanShortlogSubject(message).includes('\n')).toBe(false);
        }),
        { numRuns: RUNS },
      );
    });

    it('Then the result has no leading ASCII whitespace', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbShortlogMessage(), (message) => {
          const result = cleanShortlogSubject(message);
          expect(result).toBe(result.replace(/^[ \t\n\v\f\r]+/, ''));
        }),
        { numRuns: RUNS },
      );
    });

    it('Then the result has no trailing ASCII whitespace', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbShortlogMessage(), (message) => {
          const result = cleanShortlogSubject(message);
          expect(result).toBe(result.replace(/[ \t\n\v\f\r]+$/, ''));
        }),
        { numRuns: RUNS },
      );
    });
  });
});
