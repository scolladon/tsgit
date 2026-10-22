import { describe, expect, it } from 'vitest';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import {
  matchesPathspec,
  matchesUnmergedPath,
  pathspecMatchLevel,
  withoutExactly,
} from '../../../../src/domain/pathspec/match-pathspec.js';
import { MATCH_LEVEL } from '../../../../src/domain/pathspec/wildcard.js';

const path = (s: string): FilePath => s as FilePath;

describe('matchesPathspec', () => {
  describe('Given an empty spec', () => {
    describe('When matched against any path', () => {
      it('Then returns false', () => {
        // Arrange
        const result = matchesPathspec([], path('foo.ts'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a single literal "src/foo.ts"', () => {
    describe('When matched', () => {
      it('Then matches the exact path AND descendants', () => {
        // Arrange
        const spec = compilePathspec(['src/foo.ts']);

        // Assert
        expect(matchesPathspec(spec, path('src/foo.ts'))).toBe(true);
        expect(matchesPathspec(spec, path('src/foo.ts/inner'))).toBe(true);
        expect(matchesPathspec(spec, path('src/other.ts'))).toBe(false);
      });
    });
  });

  describe('Given a glob "*.ts"', () => {
    describe('When matched', () => {
      it('Then matches at any depth', () => {
        // Arrange
        const spec = compilePathspec(['*.ts']);

        // Assert
        expect(matchesPathspec(spec, path('foo.ts'))).toBe(true);
        expect(matchesPathspec(spec, path('src/foo.ts'))).toBe(true);
        expect(matchesPathspec(spec, path('src/a/b.ts'))).toBe(true);
        expect(matchesPathspec(spec, path('foo.tsx'))).toBe(false);
      });
    });
  });

  describe('Given an anchored glob "src/**"', () => {
    describe('When matched', () => {
      it('Then matches under "src/" only', () => {
        // Arrange
        const spec = compilePathspec(['src/**']);

        // Assert
        expect(matchesPathspec(spec, path('src/foo'))).toBe(true);
        expect(matchesPathspec(spec, path('src/a/b'))).toBe(true);
        expect(matchesPathspec(spec, path('other/src/foo'))).toBe(false);
      });
    });
  });

  describe('Given `["*.ts", "!*.test.ts"]`', () => {
    describe('When matched', () => {
      it('Then test files are excluded', () => {
        // Arrange
        const spec = compilePathspec(['*.ts', '!*.test.ts']);

        // Assert
        expect(matchesPathspec(spec, path('foo.ts'))).toBe(true);
        expect(matchesPathspec(spec, path('foo.test.ts'))).toBe(false);
        expect(matchesPathspec(spec, path('src/a.ts'))).toBe(true);
        expect(matchesPathspec(spec, path('src/a.test.ts'))).toBe(false);
      });
    });
  });

  describe('Given only negations `["!*.ts"]`', () => {
    describe('When matched', () => {
      it('Then nothing matches (starting state is false)', () => {
        // Arrange
        const spec = compilePathspec(['!*.ts']);

        // Assert
        expect(matchesPathspec(spec, path('foo.ts'))).toBe(false);
        expect(matchesPathspec(spec, path('other.md'))).toBe(false);
      });
    });
  });

  describe('Given `["!*.ts", "*.ts"]`', () => {
    describe('When matched', () => {
      it('Then the last matching rule wins → all .ts is selected', () => {
        // Arrange
        const spec = compilePathspec(['!*.ts', '*.ts']);

        // Assert
        expect(matchesPathspec(spec, path('foo.ts'))).toBe(true);
      });
    });
  });

  describe('Given `["*.ts", "!*.test.ts", "keep.test.ts"]`', () => {
    describe('When matched against keep.test.ts', () => {
      it('Then last rule re-includes it', () => {
        // Arrange
        const spec = compilePathspec(['*.ts', '!*.test.ts', 'keep.test.ts']);

        // Assert
        expect(matchesPathspec(spec, path('keep.test.ts'))).toBe(true);
        expect(matchesPathspec(spec, path('other.test.ts'))).toBe(false);
      });
    });
  });
});

describe('matchesUnmergedPath', () => {
  const MANY = 3;
  const rows: ReadonlyArray<readonly [string, readonly string[], string, number, boolean]> = [
    ['D0', ['', '!f'], 'f', MANY, true],
    ['D4', ['d', '!d/f'], 'd/f', MANY, true],
    ['D7', ['*.txt', '!f.txt'], 'f.txt', MANY, true],
    ['E1', ['f', '', '!f'], 'f', MANY, true],
    ['D5', ['', '!d'], 'd/f', MANY, false],
    ['D6', ['', '!*.txt'], 'f.txt', MANY, false],
    ['E3', ['', '!f*'], 'f', MANY, false],
    ['E7', ['', '!f', '!f*'], 'f', MANY, false],
    ['D9', ['f', '!f'], 'f', MANY, false],
    ['D10', ['top', '!f'], 'f', MANY, false],
    ['S1', ['', '!f'], 'f', 1, false],
    ['G1', ['', '!f*'], 'f*', MANY, false],
  ];

  describe.each(rows)('Given rule %s', (_id, patterns, target, entryCount, expected) => {
    describe('When matched', () => {
      it(`Then the verdict is ${expected}`, () => {
        // Arrange
        const spec = compilePathspec(patterns);
        const sut = matchesUnmergedPath;

        // Act
        const result = sut(spec, path(target), entryCount);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('withoutExactly', () => {
  describe('Given a spec with an exact literal, its descendant, a negated literal and a glob', () => {
    describe('When the exact path is removed', () => {
      it('Then only the descendant and the glob remain, in order', () => {
        // Arrange
        const spec = compilePathspec(['a', 'a/c', '!a', 'a*']);
        const sut = withoutExactly;

        // Act
        const result = sut(spec, path('a'));

        // Assert
        expect(result.map((entry) => entry.pattern)).toEqual(['a/c', 'a*']);
      });
    });
  });

  describe('Given a path named like a glob and an exclusion spelled the same', () => {
    describe('When the path is removed', () => {
      it('Then the exclusion stays because it is a glob, not a literal', () => {
        // Arrange
        const spec = compilePathspec(['', '!f*']);
        const sut = withoutExactly;

        // Act
        const result = sut(spec, path('f*'));

        // Assert
        expect(result.map((entry) => entry.pattern)).toEqual(['', '!f*']);
      });
    });
  });
});

describe('pathspecMatchLevel', () => {
  describe.each([
    ['src', 'src', MATCH_LEVEL.EXACT],
    ['src', 'src/a', MATCH_LEVEL.RECURSIVE],
    ['a?', 'a?/f', MATCH_LEVEL.RECURSIVE],
    ['a?', 'ab', MATCH_LEVEL.FNMATCH],
    ['a?', 'zz', MATCH_LEVEL.NONE],
    ['d*', 'dir/f', MATCH_LEVEL.FNMATCH],
    ['', 'x', MATCH_LEVEL.RECURSIVE],
    ['!src', 'src', MATCH_LEVEL.EXACT],
  ])('Given the pattern %j', (pattern, candidate, expected) => {
    describe(`When measured against ${candidate}`, () => {
      it(`Then the level is ${expected}`, () => {
        // Arrange
        const [entry] = compilePathspec([pattern]);

        // Act
        const result = pathspecMatchLevel(entry as NonNullable<typeof entry>, path(candidate));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
