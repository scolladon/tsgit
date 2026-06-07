import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cleanShortlogSubject } from '../../../../src/domain/shortlog/clean-subject.js';
import { arbShortlogMessage } from './arbitraries.js';

const RUNS = 200;

describe('cleanShortlogSubject properties', () => {
  describe('Given an arbitrary message, When cleaned', () => {
    it('Then it never throws', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act / Assert
      fc.assert(
        fc.property(arbShortlogMessage(), (message) => {
          expect(() => sut(message)).not.toThrow();
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe('Given an arbitrary message, When cleaned', () => {
    it('Then the result is a single line', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act / Assert
      fc.assert(
        fc.property(arbShortlogMessage(), (message) => {
          expect(sut(message).includes('\n')).toBe(false);
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe('Given an arbitrary message, When cleaned', () => {
    it('Then the result has no leading ASCII whitespace', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act / Assert
      fc.assert(
        fc.property(arbShortlogMessage(), (message) => {
          const result = sut(message);
          expect(result).toBe(result.replace(/^[ \t\n\v\f\r]+/, ''));
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe('Given an arbitrary message, When cleaned', () => {
    it('Then the result has no trailing ASCII whitespace', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act / Assert
      fc.assert(
        fc.property(arbShortlogMessage(), (message) => {
          const result = sut(message);
          expect(result).toBe(result.replace(/[ \t\n\v\f\r]+$/, ''));
        }),
        { numRuns: RUNS },
      );
    });
  });
});
