import { describe, expect, it } from 'vitest';

import { tokenizeIgnoreLine } from '../../../../src/domain/ignore/index.js';
import { FilePath } from '../../../../src/domain/objects/object-id.js';
import { compileSparseRule, nonConeMatcher } from '../../../../src/domain/sparse/non-cone.js';
import type { SparseRule } from '../../../../src/domain/sparse/sparse-pattern.js';

const path = (p: string): FilePath => FilePath.from(p);

const rule = (line: string): SparseRule => {
  const tokenized = tokenizeIgnoreLine(line);
  if (tokenized === undefined) throw new Error(`unexpected skipped line: ${line}`);
  return compileSparseRule(tokenized, line);
};

describe('compileSparseRule', () => {
  describe('Given "/src/"', () => {
    describe('When compiled', () => {
      it('Then it covers "src" and every descendant', () => {
        // Arrange / Act
        const sut = rule('/src/');

        // Assert
        expect(sut.matcher.test('src')).toBe(true);
        expect(sut.matcher.test('src/main.c')).toBe(true);
        expect(sut.matcher.test('src/a/b/c.ts')).toBe(true);
      });
    });
  });

  describe('Given "/src" (no wildcard)', () => {
    describe('When compiled', () => {
      it('Then it covers "src" and every descendant', () => {
        // Arrange / Act
        const sut = rule('/src');

        // Assert
        expect(sut.matcher.test('src')).toBe(true);
        expect(sut.matcher.test('src/main.c')).toBe(true);
      });
    });
  });

  describe('Given "*.ts"', () => {
    describe('When compiled', () => {
      it('Then it covers any .ts file at any depth', () => {
        // Arrange / Act
        const sut = rule('*.ts');

        // Assert
        expect(sut.matcher.test('main.ts')).toBe(true);
        expect(sut.matcher.test('src/app/main.ts')).toBe(true);
        expect(sut.matcher.test('main.js')).toBe(false);
      });
    });
  });

  describe('Given "/src/*" (wildcard last segment)', () => {
    describe('When compiled', () => {
      it('Then it covers only direct children', () => {
        // Arrange / Act
        const sut = rule('/src/*');

        // Assert
        expect(sut.matcher.test('src/main.c')).toBe(true);
        expect(sut.matcher.test('src/a/b.c')).toBe(false);
      });
    });
  });

  describe('Given "build"', () => {
    describe('When compiled', () => {
      it('Then it covers any build subtree at any depth', () => {
        // Arrange / Act
        const sut = rule('build');

        // Assert
        expect(sut.matcher.test('build')).toBe(true);
        expect(sut.matcher.test('build/out.o')).toBe(true);
        expect(sut.matcher.test('pkg/build/out.o')).toBe(true);
      });
    });
  });

  describe('Given a "?"-wildcard last segment', () => {
    describe('When compiled', () => {
      it('Then it is non-recursive', () => {
        // Arrange — `?` is a glob metacharacter, so the rule does not cover descendants.
        const sut = rule('/src/a?c');

        // Assert
        expect(sut.matcher.test('src/abc')).toBe(true);
        expect(sut.matcher.test('src/abc/deep.ts')).toBe(false);
      });
    });
  });

  describe('Given a directory-only rule with a wildcard last segment', () => {
    describe('When compiled', () => {
      it('Then directoryOnly alone makes it recursive', () => {
        // Arrange — `/src*/` has a glob (`*`) last segment, so the only reason it
        // covers descendants is the trailing-slash directory-only flag.
        const sut = rule('/src*/');

        // Assert
        expect(sut.matcher.test('src-app')).toBe(true);
        expect(sut.matcher.test('src-app/deep/file.ts')).toBe(true);
      });
    });
  });

  describe('Given a "!"-prefixed line', () => {
    describe('When compiled', () => {
      it('Then the rule is negated and carries the source', () => {
        // Arrange / Act
        const sut = rule('!build');

        // Assert
        expect(sut.negated).toBe(true);
        expect(sut.source).toBe('!build');
      });
    });
  });

  describe('Given a plain line', () => {
    describe('When compiled', () => {
      it('Then the rule is not negated', () => {
        // Arrange / Act
        const sut = rule('build');

        // Assert
        expect(sut.negated).toBe(false);
      });
    });
  });
});

describe('nonConeMatcher', () => {
  describe('Given a set of non-cone rules and a path', () => {
    describe('When matched', () => {
      it.each([
        {
          rules: [],
          filePath: 'any/file.ts',
          expected: false,
          label: 'no rules leaves nothing in the sparse set',
        },
        {
          rules: [rule('/src/')],
          filePath: 'src/main.ts',
          expected: true,
          label: 'a single covering rule includes the path',
        },
        {
          rules: [rule('/src/')],
          filePath: 'docs/guide.md',
          expected: false,
          label: 'a covering rule excludes a non-covered path',
        },
        {
          rules: [rule('/src/'), rule('!/src/secret/')],
          filePath: 'src/secret/key.ts',
          expected: false,
          label: 'an include then a negation: the negation wins (last-match)',
        },
        {
          rules: [rule('/src/'), rule('!/src/secret/'), rule('/src/secret/pub.ts')],
          filePath: 'src/secret/pub.ts',
          expected: true,
          label: 'a negation then a re-include: the re-include wins (last-match)',
        },
        {
          rules: [rule('/src/'), rule('!/src/secret/')],
          filePath: 'lib/util.ts',
          expected: false,
          label: 'a path matched by no rule defaults to excluded',
        },
      ])('Then $label', ({ rules, filePath, expected }) => {
        // Arrange
        const sut = nonConeMatcher(rules);

        // Act
        const result = sut(path(filePath));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
