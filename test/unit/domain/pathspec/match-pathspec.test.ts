import { describe, expect, it } from 'vitest';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import { matchesPathspec } from '../../../../src/domain/pathspec/match-pathspec.js';

const path = (s: string): FilePath => s as FilePath;

describe('matchesPathspec', () => {
  it('Given an empty spec, When matched against any path, Then returns false', () => {
    // Arrange
    // Assert
    expect(matchesPathspec([], path('foo.ts'))).toBe(false);
  });

  it('Given a single literal "src/foo.ts", When matched, Then matches the exact path AND descendants', () => {
    // Arrange
    const sut = compilePathspec(['src/foo.ts']);

    // Assert
    expect(matchesPathspec(sut, path('src/foo.ts'))).toBe(true);
    expect(matchesPathspec(sut, path('src/foo.ts/inner'))).toBe(true);
    expect(matchesPathspec(sut, path('src/other.ts'))).toBe(false);
  });

  it('Given a glob "*.ts", When matched, Then matches at any depth', () => {
    // Arrange
    const sut = compilePathspec(['*.ts']);

    // Assert
    expect(matchesPathspec(sut, path('foo.ts'))).toBe(true);
    expect(matchesPathspec(sut, path('src/foo.ts'))).toBe(true);
    expect(matchesPathspec(sut, path('src/a/b.ts'))).toBe(true);
    expect(matchesPathspec(sut, path('foo.tsx'))).toBe(false);
  });

  it('Given an anchored glob "src/**", When matched, Then matches under "src/" only', () => {
    // Arrange
    const sut = compilePathspec(['src/**']);

    // Assert
    expect(matchesPathspec(sut, path('src/foo'))).toBe(true);
    expect(matchesPathspec(sut, path('src/a/b'))).toBe(true);
    expect(matchesPathspec(sut, path('other/src/foo'))).toBe(false);
  });

  it('Given `["*.ts", "!*.test.ts"]`, When matched, Then test files are excluded', () => {
    // Arrange
    const sut = compilePathspec(['*.ts', '!*.test.ts']);

    // Assert
    expect(matchesPathspec(sut, path('foo.ts'))).toBe(true);
    expect(matchesPathspec(sut, path('foo.test.ts'))).toBe(false);
    expect(matchesPathspec(sut, path('src/a.ts'))).toBe(true);
    expect(matchesPathspec(sut, path('src/a.test.ts'))).toBe(false);
  });

  it('Given only negations `["!*.ts"]`, When matched, Then nothing matches (starting state is false)', () => {
    // Arrange
    const sut = compilePathspec(['!*.ts']);

    // Assert
    expect(matchesPathspec(sut, path('foo.ts'))).toBe(false);
    expect(matchesPathspec(sut, path('other.md'))).toBe(false);
  });

  it('Given `["!*.ts", "*.ts"]`, When matched, Then the last matching rule wins → all .ts is selected', () => {
    // Arrange
    const sut = compilePathspec(['!*.ts', '*.ts']);

    // Assert
    expect(matchesPathspec(sut, path('foo.ts'))).toBe(true);
  });

  it('Given `["*.ts", "!*.test.ts", "keep.test.ts"]`, When matched against keep.test.ts, Then last rule re-includes it', () => {
    // Arrange
    const sut = compilePathspec(['*.ts', '!*.test.ts', 'keep.test.ts']);

    // Assert
    expect(matchesPathspec(sut, path('keep.test.ts'))).toBe(true);
    expect(matchesPathspec(sut, path('other.test.ts'))).toBe(false);
  });
});
