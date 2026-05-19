import { describe, expect, it } from 'vitest';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import { matchesPathspec } from '../../../../src/domain/pathspec/match-pathspec.js';

const path = (s: string): FilePath => s as FilePath;

describe('matchesPathspec', () => {
  it('Given an empty spec, When matched against any path, Then returns false', () => {
    expect(matchesPathspec([], path('foo.ts'), false)).toBe(false);
  });

  it('Given a single literal "src/foo.ts", When matched, Then matches the exact path AND descendants', () => {
    const sut = compilePathspec(['src/foo.ts']);

    expect(matchesPathspec(sut, path('src/foo.ts'), false)).toBe(true);
    expect(matchesPathspec(sut, path('src/foo.ts/inner'), false)).toBe(true);
    expect(matchesPathspec(sut, path('src/other.ts'), false)).toBe(false);
  });

  it('Given a glob "*.ts", When matched, Then matches at any depth', () => {
    const sut = compilePathspec(['*.ts']);

    expect(matchesPathspec(sut, path('foo.ts'), false)).toBe(true);
    expect(matchesPathspec(sut, path('src/foo.ts'), false)).toBe(true);
    expect(matchesPathspec(sut, path('src/a/b.ts'), false)).toBe(true);
    expect(matchesPathspec(sut, path('foo.tsx'), false)).toBe(false);
  });

  it('Given an anchored glob "src/**", When matched, Then matches under "src/" only', () => {
    const sut = compilePathspec(['src/**']);

    expect(matchesPathspec(sut, path('src/foo'), false)).toBe(true);
    expect(matchesPathspec(sut, path('src/a/b'), false)).toBe(true);
    expect(matchesPathspec(sut, path('other/src/foo'), false)).toBe(false);
  });

  it('Given `["*.ts", "!*.test.ts"]`, When matched, Then test files are excluded', () => {
    const sut = compilePathspec(['*.ts', '!*.test.ts']);

    expect(matchesPathspec(sut, path('foo.ts'), false)).toBe(true);
    expect(matchesPathspec(sut, path('foo.test.ts'), false)).toBe(false);
    expect(matchesPathspec(sut, path('src/a.ts'), false)).toBe(true);
    expect(matchesPathspec(sut, path('src/a.test.ts'), false)).toBe(false);
  });

  it('Given only negations `["!*.ts"]`, When matched, Then nothing matches (starting state is false)', () => {
    const sut = compilePathspec(['!*.ts']);

    expect(matchesPathspec(sut, path('foo.ts'), false)).toBe(false);
    expect(matchesPathspec(sut, path('other.md'), false)).toBe(false);
  });

  it('Given `["!*.ts", "*.ts"]`, When matched, Then the last matching rule wins → all .ts is selected', () => {
    const sut = compilePathspec(['!*.ts', '*.ts']);

    expect(matchesPathspec(sut, path('foo.ts'), false)).toBe(true);
  });

  it('Given `["*.ts", "!*.test.ts", "keep.test.ts"]`, When matched against keep.test.ts, Then last rule re-includes it', () => {
    const sut = compilePathspec(['*.ts', '!*.test.ts', 'keep.test.ts']);

    expect(matchesPathspec(sut, path('keep.test.ts'), false)).toBe(true);
    expect(matchesPathspec(sut, path('other.test.ts'), false)).toBe(false);
  });
});
