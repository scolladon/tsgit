import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileGlob } from '../../../../src/domain/pathspec/compile-glob.js';
import { arbLiteralPattern } from './arbitraries.js';

const NUM_RUNS = 100;
const PRINTABLE_ASCII_NO_NUL = fc.string({
  unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)),
  maxLength: 16,
});

describe('compileGlob properties', () => {
  describe('Given an arbitrary printable-ASCII pattern and options', () => {
    describe('When the compiled matcher tests an arbitrary path', () => {
      it('Then it returns a boolean', () => {
        fc.assert(
          fc.property(
            PRINTABLE_ASCII_NO_NUL,
            fc.boolean(),
            fc.boolean(),
            PRINTABLE_ASCII_NO_NUL,
            (pattern, anchored, withDirSuffix, path) => {
              // Arrange
              const sut = compileGlob;

              // Act
              const result = sut(pattern, { anchored, withDirSuffix }).test(path);

              // Assert
              expect(typeof result).toBe('boolean');
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given a pattern made only of literal segments', () => {
    describe('When compiled anchored and tested against itself', () => {
      it('Then it matches exactly itself and rejects itself plus a suffix', () => {
        fc.assert(
          fc.property(fc.array(arbLiteralPattern(), { minLength: 1, maxLength: 4 }), (segments) => {
            // Arrange
            const pattern = segments.join('/');
            const sut = compileGlob;

            // Act
            const matcher = sut(pattern, { anchored: true });

            // Assert
            expect(matcher.test(pattern)).toBe(true);
            expect(matcher.test(`${pattern}x`)).toBe(false);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
