import { describe, expect, it } from 'vitest';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';

describe('compilePathspec', () => {
  describe('Given an empty list', () => {
    describe('When compiled', () => {
      it('Then yields an empty array', () => {
        // Arrange
        const result = compilePathspec([]);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given the whole-tree literal (an empty body)', () => {
    describe('When compiled', () => {
      it('Then yields a literal entry matching every path', () => {
        // Arrange
        const sut = compilePathspec;

        // Act
        const result = sut(['']);

        // Assert
        expect(result[0]?.isLiteral).toBe(true);
        expect(result[0]?.compiled.test('a')).toBe(true);
        expect(result[0]?.compiled.test('d/b')).toBe(true);
      });
    });
  });

  describe('Given a single literal "src/foo.ts"', () => {
    describe('When compiled', () => {
      it('Then yields one literal entry with regex matching path-or-descendants', () => {
        // Arrange
        const result = compilePathspec(['src/foo.ts']);

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.isLiteral).toBe(true);
        expect(result[0]?.negated).toBe(false);
        expect(result[0]?.compiled.test('src/foo.ts')).toBe(true);
        // Literal acts as directory prefix.
        expect(result[0]?.compiled.test('src/foo.ts/inner')).toBe(true);
        expect(result[0]?.compiled.test('src/other.ts')).toBe(false);
      });
    });
  });

  describe('Given a glob "*.ts"', () => {
    describe('When compiled', () => {
      it('Then yields a non-literal entry', () => {
        // Arrange
        const result = compilePathspec(['*.ts']);

        // Assert
        expect(result[0]?.isLiteral).toBe(false);
        expect(result[0]?.negated).toBe(false);
        // `*` crosses `/`, so the suffix matches at any depth.
        expect(result[0]?.compiled.test('foo.ts')).toBe(true);
        expect(result[0]?.compiled.test('src/foo.ts')).toBe(true);
      });
    });
  });

  describe('Given a glob "src/**"', () => {
    describe('When compiled', () => {
      it('Then yields a non-literal entry', () => {
        // Arrange
        const result = compilePathspec(['src/**']);

        // Assert
        expect(result[0]?.isLiteral).toBe(false);
        // The prefix is rooted: a nested `src` does not match.
        expect(result[0]?.compiled.test('src/foo')).toBe(true);
        expect(result[0]?.compiled.test('src/a/b/c')).toBe(true);
        expect(result[0]?.compiled.test('other/src/x')).toBe(false);
      });
    });
  });

  describe('Given a "!"-prefixed literal "!src/foo"', () => {
    describe('When compiled', () => {
      it('Then negated=true and the body parses as literal', () => {
        // Arrange
        const result = compilePathspec(['!src/foo']);

        // Assert
        expect(result[0]?.negated).toBe(true);
        expect(result[0]?.isLiteral).toBe(true);
        expect(result[0]?.pattern).toBe('!src/foo');
        expect(result[0]?.compiled.test('src/foo')).toBe(true);
      });
    });
  });

  describe('Given a bare literal "lib"', () => {
    describe('When compiled', () => {
      it('Then the regex matches the directory AND every descendant (withDirSuffix is enabled)', () => {
        // Arrange — a literal pathspec compiles with `withDirSuffix: true`, so the
        // regex must cover descendants. If the flag were `false` the regex would be
        // `^lib$` and reject everything below `lib`.
        const result = compilePathspec(['lib']);

        // Act / Assert
        expect(result[0]?.compiled.test('lib')).toBe(true);
        expect(result[0]?.compiled.test('lib/a.ts')).toBe(true);
        expect(result[0]?.compiled.test('lib/nested/deep.ts')).toBe(true);
        expect(result[0]?.compiled.test('libs')).toBe(false);
      });
    });
  });

  describe('Given a literal pathspec "lib"', () => {
    describe('When compiled', () => {
      it('Then the regex matches a descendant path "lib/foo.ts" (withDirSuffix directory semantics)', () => {
        // Arrange — a literal pathspec compiles with `withDirSuffix: true`, so a
        // bare `lib` covers `lib` itself and everything beneath it (Git's
        // `git add lib` directory-prefix semantics). A mutant flipping the flag
        // to `false` yields `^lib$`, which rejects `lib/foo.ts`.
        const result = compilePathspec(['lib']);

        // Act / Assert
        expect(result[0]?.compiled.test('lib/foo.ts')).toBe(true);
      });
      it('Then the regex is anchored at the repo root and rejects "vendor/lib"', () => {
        // Arrange — a literal pathspec compiles with `anchored: true`, so the regex
        // is `^lib(/.*)?$`. It must match `lib` at the root only, NOT a `lib`
        // segment nested under another directory. A mutant flipping `anchored` to
        // `false` yields `(^|.*/)lib(/.*)?$`, which would wrongly match
        // `vendor/lib` and `a/b/lib`.
        const result = compilePathspec(['lib']);

        // Act / Assert
        expect(result[0]?.compiled.test('lib')).toBe(true);
        expect(result[0]?.compiled.test('vendor/lib')).toBe(false);
        expect(result[0]?.compiled.test('a/b/lib')).toBe(false);
        expect(result[0]?.compiled.test('vendor/lib/x.ts')).toBe(false);
      });
    });
  });

  describe('Given a "!"-prefixed glob "!*.test.ts"', () => {
    describe('When compiled', () => {
      it('Then negated=true with glob semantics', () => {
        // Arrange
        const result = compilePathspec(['!*.test.ts']);

        // Assert
        expect(result[0]?.negated).toBe(true);
        expect(result[0]?.isLiteral).toBe(false);
        expect(result[0]?.compiled.test('foo.test.ts')).toBe(true);
      });
    });
  });

  describe('Given multiple patterns', () => {
    describe('When compiled', () => {
      it('Then the order is preserved', () => {
        // Arrange
        const result = compilePathspec(['*.ts', '!*.test.ts', 'src/foo']);

        // Assert
        expect(result.map((e) => e.pattern)).toEqual(['*.ts', '!*.test.ts', 'src/foo']);
      });
    });
  });

  describe.each([
    { body: 'a[', expected: false },
    { body: 'a\\', expected: false },
    { body: '[]a]', expected: false },
    { body: 'a\\b', expected: false },
    { body: 'src/foo.ts', expected: true },
  ])('Given the body "$body"', ({ body, expected }) => {
    describe('When compiled', () => {
      it('Then isLiteral is the expected flag', () => {
        // Arrange
        const sut = compilePathspec;
        // Act
        const result = sut([body]);
        // Assert
        expect(result[0]?.isLiteral).toBe(expected);
      });
    });
  });

  describe.each([
    { body: 'foo*', path: 'dir/foobar', expected: false },
    { body: 'src/*.ts', path: 'src/a/b.ts', expected: true },
  ])('Given the glob "$body"', ({ body, path, expected }) => {
    describe('When testing "$path"', () => {
      it('Then the verdict follows the wildmatch dialect', () => {
        // Arrange
        const sut = compilePathspec;
        // Act
        const result = sut([body])[0]?.compiled.test(path);
        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
