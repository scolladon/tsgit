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
  describe('Given caseFold over a small alphabet', () => {
    const arbText = fc.stringMatching(/^[aAbB/*?]{0,8}$/);
    const arbPath = fc.stringMatching(/^[aAbB/]{0,8}$/);
    const arbMask = fc.array(fc.boolean(), { maxLength: 8 });
    const flipAsciiCase = (text: string, mask: ReadonlyArray<boolean>): string =>
      [...text]
        .map((ch, i) => {
          if (mask[i] !== true) return ch;
          return ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
        })
        .join('');

    describe('When the path has its ASCII case flipped', () => {
      it('Then the verdict is unchanged', () => {
        fc.assert(
          fc.property(
            arbText,
            arbPath,
            arbMask,
            fc.boolean(),
            fc.boolean(),
            (pattern, path, mask, anchored, withDirSuffix) => {
              // Arrange
              const sut = compileGlob(pattern, { anchored, withDirSuffix, caseFold: true });

              // Act
              const result = sut.test(flipAsciiCase(path, mask));

              // Assert
              expect(result).toBe(sut.test(path));
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });

    describe('When the exact matcher accepts a path', () => {
      it('Then the folding matcher accepts it too', () => {
        fc.assert(
          fc.property(
            arbText,
            arbPath,
            fc.boolean(),
            fc.boolean(),
            (pattern, path, anchored, withDirSuffix) => {
              // Arrange
              const options = { anchored, withDirSuffix };
              const exact = compileGlob(pattern, options);
              const sut = compileGlob(pattern, { ...options, caseFold: true });

              // Act
              const result = sut.test(path);

              // Assert
              expect(result || !exact.test(path)).toBe(true);
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
