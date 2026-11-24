import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/domain/glob/wildmatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/domain/glob/wildmatch.js')>();
  return { ...actual, matchWildmatch: vi.fn(actual.matchWildmatch) };
});

// A runner sharing one module registry across suites may hold the compiler
// already bound to the real program: both are loaded afresh here.
vi.resetModules();
const { matchWildmatch } = await import('../../../../src/domain/glob/wildmatch.js');
const { compileGlob } = await import('../../../../src/domain/pathspec/compile-glob.js');

const programRuns = vi.mocked(matchWildmatch);

describe('compileGlob — verdicts decided before the wildmatch program', () => {
  beforeEach(() => {
    programRuns.mockClear();
  });

  describe('Given a pattern of plain text', () => {
    describe('When testing a path', () => {
      it.each([
        [true, 'ab', 'ab', true],
        [true, 'ab', 'ad', false],
        [false, 'ab', 'ab', true],
        [false, 'ab', 'x/ab', true],
        [false, 'ab', 'cab', false],
      ])(
        'Then anchored %s, %j against %j gives %s and the program never runs',
        (anchored, pattern, path, expected) => {
          // Arrange
          const sut = compileGlob(pattern, { anchored });

          // Act
          const result = sut.test(path);

          // Assert
          expect(result).toBe(expected);
          expect(programRuns).not.toHaveBeenCalled();
        },
      );
    });
  });

  describe('Given an unanchored star followed by plain text', () => {
    describe('When testing a path', () => {
      it.each([
        ['*.log', 'x.log', true],
        ['*.log', 'd/x.log', true],
        ['*.log', 'x.txt', false],
        ['*', 'anything', true],
      ])('Then %j against %j gives %s and the program never runs', (pattern, path, expected) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored: false });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(expected);
        expect(programRuns).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given an anchored star followed by plain text', () => {
    describe('When testing a path the suffix fits', () => {
      it('Then the program decides', () => {
        // Arrange
        const sut = compileGlob('*.log', { anchored: true });

        // Act
        const result = sut.test('x.log');

        // Assert
        expect(result).toBe(true);
        expect(programRuns).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a pattern with a plain prefix', () => {
    describe('When the path lacks the prefix', () => {
      it.each([
        [true, 'src/*.c', 'lib/x.c'],
        [false, 'ab*', 'cd'],
        [false, 'ab*', 'x/cd'],
      ])(
        'Then anchored %s, %j refuses %j and the program never runs',
        (anchored, pattern, path) => {
          // Arrange
          const sut = compileGlob(pattern, { anchored });

          // Act
          const result = sut.test(path);

          // Assert
          expect(result).toBe(false);
          expect(programRuns).not.toHaveBeenCalled();
        },
      );
    });

    describe('When the path carries the prefix', () => {
      it.each([
        [true, 'src/*.c', 'src/x.c'],
        [false, 'ab*', 'abc'],
        [false, 'ab*', 'x/abc'],
      ])('Then anchored %s, %j leaves %j to the program', (anchored, pattern, path) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(true);
        expect(programRuns).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a pattern whose last star is followed by one-byte tokens', () => {
    describe('When the last bytes of the path cannot be those tokens', () => {
      it.each([
        ['*x[ch]', 'ayc'],
        ['*x[ch]', 'axo'],
        ['*[ch]', 'xo'],
        ['*[ch]x', 'cy'],
        ['*x[ch]', 'c'],
      ])('Then %j refuses %j and the program never runs', (pattern, path) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored: true });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(false);
        expect(programRuns).not.toHaveBeenCalled();
      });
    });

    describe('When the last bytes of the path fit those tokens', () => {
      it.each([
        ['*x[ch]', 'axc', true],
        ['*[ch]', 'xh', true],
        ['?*x[ch]', 'xc', false],
      ])('Then %j leaves %j to the program, which gives %s', (pattern, path, expected) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored: true });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(expected);
        expect(programRuns).toHaveBeenCalledTimes(1);
      });
    });
  });
});
