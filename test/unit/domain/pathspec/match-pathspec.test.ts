import { describe, expect, it } from 'vitest';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import { matchesPathspec } from '../../../../src/domain/pathspec/match-pathspec.js';

const path = (s: string): FilePath => s as FilePath;

describe('matchesPathspec', () => {
  describe('Given an empty spec', () => {
    describe('When matched against any path', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = matchesPathspec([], path('foo.ts'));

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given a single literal "src/foo.ts"', () => {
    describe('When matched', () => {
      it('Then matches the exact path AND descendants', () => {
        // Arrange
        const sut = compilePathspec(['src/foo.ts']);

        // Assert
        expect(matchesPathspec(sut, path('src/foo.ts'))).toBe(true);
        expect(matchesPathspec(sut, path('src/foo.ts/inner'))).toBe(true);
        expect(matchesPathspec(sut, path('src/other.ts'))).toBe(false);
      });
    });
  });

  describe('Given a glob "*.ts"', () => {
    describe('When matched', () => {
      it('Then matches at any depth', () => {
        // Arrange
        const sut = compilePathspec(['*.ts']);

        // Assert
        expect(matchesPathspec(sut, path('foo.ts'))).toBe(true);
        expect(matchesPathspec(sut, path('src/foo.ts'))).toBe(true);
        expect(matchesPathspec(sut, path('src/a/b.ts'))).toBe(true);
        expect(matchesPathspec(sut, path('foo.tsx'))).toBe(false);
      });
    });
  });

  describe('Given an anchored glob "src/**"', () => {
    describe('When matched', () => {
      it('Then matches under "src/" only', () => {
        // Arrange
        const sut = compilePathspec(['src/**']);

        // Assert
        expect(matchesPathspec(sut, path('src/foo'))).toBe(true);
        expect(matchesPathspec(sut, path('src/a/b'))).toBe(true);
        expect(matchesPathspec(sut, path('other/src/foo'))).toBe(false);
      });
    });
  });

  describe('Given `["*.ts", "!*.test.ts"]`', () => {
    describe('When matched', () => {
      it('Then test files are excluded', () => {
        // Arrange
        const sut = compilePathspec(['*.ts', '!*.test.ts']);

        // Assert
        expect(matchesPathspec(sut, path('foo.ts'))).toBe(true);
        expect(matchesPathspec(sut, path('foo.test.ts'))).toBe(false);
        expect(matchesPathspec(sut, path('src/a.ts'))).toBe(true);
        expect(matchesPathspec(sut, path('src/a.test.ts'))).toBe(false);
      });
    });
  });

  describe('Given only negations `["!*.ts"]`', () => {
    describe('When matched', () => {
      it('Then nothing matches (starting state is false)', () => {
        // Arrange
        const sut = compilePathspec(['!*.ts']);

        // Assert
        expect(matchesPathspec(sut, path('foo.ts'))).toBe(false);
        expect(matchesPathspec(sut, path('other.md'))).toBe(false);
      });
    });
  });

  describe('Given `["!*.ts", "*.ts"]`', () => {
    describe('When matched', () => {
      it('Then the last matching rule wins → all .ts is selected', () => {
        // Arrange
        const sut = compilePathspec(['!*.ts', '*.ts']);

        // Assert
        expect(matchesPathspec(sut, path('foo.ts'))).toBe(true);
      });
    });
  });

  describe('Given `["*.ts", "!*.test.ts", "keep.test.ts"]`', () => {
    describe('When matched against keep.test.ts', () => {
      it('Then last rule re-includes it', () => {
        // Arrange
        const sut = compilePathspec(['*.ts', '!*.test.ts', 'keep.test.ts']);

        // Assert
        expect(matchesPathspec(sut, path('keep.test.ts'))).toBe(true);
        expect(matchesPathspec(sut, path('other.test.ts'))).toBe(false);
      });
    });
  });
});
