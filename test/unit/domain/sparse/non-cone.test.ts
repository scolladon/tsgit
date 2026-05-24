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
  describe('Given no rules', () => {
    describe('When matched', () => {
      it('Then nothing is in the sparse set', () => {
        // Arrange
        const sut = nonConeMatcher([]);

        // Act
        const result = sut(path('any/file.ts'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a single covering rule', () => {
    describe('When matched', () => {
      it('Then the path is included', () => {
        // Arrange
        const sut = nonConeMatcher([rule('/src/')]);

        // Act
        const result = sut(path('src/main.ts'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a covering rule', () => {
    describe('When a non-covered path is matched', () => {
      it('Then it is excluded', () => {
        // Arrange
        const sut = nonConeMatcher([rule('/src/')]);

        // Act
        const result = sut(path('docs/guide.md'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an include then a negation', () => {
    describe('When matched', () => {
      it('Then the negation wins (last-match)', () => {
        // Arrange
        const sut = nonConeMatcher([rule('/src/'), rule('!/src/secret/')]);

        // Act
        const result = sut(path('src/secret/key.ts'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a negation then a re-include', () => {
    describe('When matched', () => {
      it('Then the re-include wins (last-match)', () => {
        // Arrange
        const sut = nonConeMatcher([
          rule('/src/'),
          rule('!/src/secret/'),
          rule('/src/secret/pub.ts'),
        ]);

        // Act
        const result = sut(path('src/secret/pub.ts'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a path matched by no rule', () => {
    describe('When matched', () => {
      it('Then it defaults to excluded', () => {
        // Arrange
        const sut = nonConeMatcher([rule('/src/'), rule('!/src/secret/')]);

        // Act
        const result = sut(path('lib/util.ts'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
