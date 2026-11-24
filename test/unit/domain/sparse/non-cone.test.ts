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

describe('compileSparseRule with caseFold', () => {
  const tokenized = (line: string) => {
    const tokens = tokenizeIgnoreLine(line);
    if (tokens === undefined) throw new Error(`unexpected skipped line: ${line}`);
    return tokens;
  };

  describe('Given "/b/"', () => {
    describe('When tested against "B"', () => {
      it('Then it matches', () => {
        // Arrange
        const sut = compileSparseRule;

        // Act
        const result = sut(tokenized('/b/'), '/b/', { caseFold: true }).matcher.test('B');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given "/b/" and no case folding asked', () => {
    describe('When tested against "B"', () => {
      it('Then it does not match', () => {
        // Arrange
        const sut = compileSparseRule;

        // Act
        const result = sut(tokenized('/b/'), '/b/').matcher.test('B');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a negated "!/B/x"', () => {
    describe('When tested against "b/x"', () => {
      it('Then its matcher matches and the rule stays negated', () => {
        // Arrange
        const sut = compileSparseRule;

        // Act
        const result = sut(tokenized('!/B/x'), '!/B/x', { caseFold: true });

        // Assert
        expect(result.matcher.test('b/x')).toBe(true);
        expect(result.negated).toBe(true);
      });
    });
  });
});

describe('compileSparseRule', () => {
  describe('Given "/src/"', () => {
    describe('When compiled', () => {
      it('Then it judges "src" alone and is directory-only', () => {
        // Arrange / Act
        const result = rule('/src/');

        // Assert
        expect(result.matcher.test('src')).toBe(true);
        expect(result.matcher.test('src/main.c')).toBe(false);
        expect(result.directoryOnly).toBe(true);
      });
    });
  });

  describe('Given "/src" (no wildcard)', () => {
    describe('When compiled', () => {
      it('Then it judges "src" alone and is not directory-only', () => {
        // Arrange / Act
        const result = rule('/src');

        // Assert
        expect(result.matcher.test('src')).toBe(true);
        expect(result.matcher.test('src/main.c')).toBe(false);
        expect(result.directoryOnly).toBe(false);
      });
    });
  });

  describe('Given "*.ts"', () => {
    describe('When compiled', () => {
      it('Then it covers any .ts file at any depth', () => {
        // Arrange / Act
        const result = rule('*.ts');

        // Assert
        expect(result.matcher.test('main.ts')).toBe(true);
        expect(result.matcher.test('src/app/main.ts')).toBe(true);
        expect(result.matcher.test('main.js')).toBe(false);
      });
    });
  });

  describe('Given "/src/*" (wildcard last segment)', () => {
    describe('When compiled', () => {
      it('Then it covers only direct children', () => {
        // Arrange / Act
        const result = rule('/src/*');

        // Assert
        expect(result.matcher.test('src/main.c')).toBe(true);
        expect(result.matcher.test('src/a/b.c')).toBe(false);
      });
    });
  });

  describe('Given "build"', () => {
    describe('When compiled', () => {
      it('Then it judges a "build" component at any depth, not its descendants', () => {
        // Arrange / Act
        const result = rule('build');

        // Assert
        expect(result.matcher.test('build')).toBe(true);
        expect(result.matcher.test('pkg/build')).toBe(true);
        expect(result.matcher.test('build/out.o')).toBe(false);
      });
    });
  });

  describe('Given "/a**b", a star run inside one component', () => {
    describe('When compiled', () => {
      it('Then the run stays within the component, as git matches it under WM_PATHNAME', () => {
        // Arrange
        const sut = rule;

        // Act
        const result = sut('/a**b');

        // Assert
        expect(result.matcher.test('axb')).toBe(true);
        expect(result.matcher.test('a/b')).toBe(false);
      });
    });
  });

  describe('Given a "?"-wildcard last segment', () => {
    describe('When compiled', () => {
      it('Then it judges only the matching component', () => {
        // Arrange
        const result = rule('/src/a?c');

        // Assert
        expect(result.matcher.test('src/abc')).toBe(true);
        expect(result.matcher.test('src/abc/deep.ts')).toBe(false);
      });
    });
  });

  describe('Given a directory-only rule with a wildcard last segment', () => {
    describe('When compiled', () => {
      it('Then the trailing slash sets directoryOnly and the glob judges one level', () => {
        // Arrange
        const result = rule('/src*/');

        // Assert
        expect(result.directoryOnly).toBe(true);
        expect(result.matcher.test('src-app')).toBe(true);
        expect(result.matcher.test('src-app/deep/file.ts')).toBe(false);
      });
    });
  });

  describe('Given a "!"-prefixed line', () => {
    describe('When compiled', () => {
      it('Then the rule is negated and carries the source', () => {
        // Arrange / Act
        const result = rule('!build');

        // Assert
        expect(result.negated).toBe(true);
        expect(result.source).toBe('!build');
      });
    });
  });

  describe('Given a plain line', () => {
    describe('When compiled', () => {
      it('Then the rule is not negated', () => {
        // Arrange / Act
        const result = rule('build');

        // Assert
        expect(result.negated).toBe(false);
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

describe('nonConeMatcher directory inheritance', () => {
  describe('Given "/*" then "!/d*/s*"', () => {
    describe.each([
      { filePath: 'top.txt', expected: true, label: 'a top-level file is included' },
      { filePath: 'd0/keep', expected: true, label: 'a file no rule names inherits its directory' },
      { filePath: 'd0/s0', expected: false, label: 'a negated file is excluded' },
      {
        filePath: 'd0/x/y',
        expected: true,
        label: 'a deeper file inherits the nearest decided directory',
      },
      {
        filePath: 'd0/sub/deep',
        expected: false,
        label: 'a file under a directory the negation names is excluded',
      },
    ])('When tested against $filePath', ({ filePath, expected, label }) => {
      it(`Then ${label}`, () => {
        // Arrange
        const sut = nonConeMatcher([rule('/*'), rule('!/d*/s*')]);

        // Act
        const result = sut(path(filePath));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given "/src/*" then "!/src/f"', () => {
    describe('When tested against a file two levels under src', () => {
      it('Then it is included through its decided directory', () => {
        // Arrange
        const sut = nonConeMatcher([rule('/src/*'), rule('!/src/f')]);

        // Act
        const result = sut(path('src/a/b/c'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});

describe('nonConeMatcher level-by-level verdicts', () => {
  // Every row is the verdict of `git read-tree -mu HEAD` followed by
  // `git -c sparse.expectFilesOutsideOfPatterns=true ls-files -t` on git 2.56:
  // `true` is an `H` (in the sparse set), `false` an `S` (skip-worktree).
  describe.each([
    { lines: ['/a/b/', '!/a/*'], filePath: 'a/b/f', expected: false },
    { lines: ['/a/b/', '!/a/*'], filePath: 'a/x', expected: false },
    { lines: ['a/'], filePath: 'b/a', expected: false },
    { lines: ['sub/'], filePath: 'sub', expected: false },
    { lines: ['sub/'], filePath: 'sub/f', expected: true },
    { lines: ['sub/'], filePath: 'x/sub/f', expected: true },
    { lines: ['a', '!a/'], filePath: 'x/a', expected: true },
    { lines: ['/a', '!/a/*', '/a/k'], filePath: 'a/z/s', expected: false },
    { lines: ['/a', '!/a/*', '/a/k'], filePath: 'a/k/q', expected: true },
    { lines: ['*', '!x/'], filePath: 'x/f', expected: true },
    { lines: ['*', '!x/'], filePath: 'x/y/g', expected: true },
    { lines: ['*', '!x/'], filePath: 'top', expected: true },
    { lines: ['/d0/', '!/d0/*'], filePath: 'd0/sub/y', expected: false },
    { lines: ['/d0/', '!/d0/*'], filePath: 'd0/x', expected: false },
    { lines: ['/*', '!/*/', '/b/'], filePath: 'top', expected: true },
    { lines: ['/*', '!/*/', '/b/'], filePath: 'b/f', expected: true },
    { lines: ['/*', '!/*/', '/b/'], filePath: 'c/f', expected: false },
    { lines: ['/*', '!/a/', '/a/b/'], filePath: 'a/b/f', expected: true },
    { lines: ['/*', '!/a/', '/a/b/'], filePath: 'a/f', expected: false },
    { lines: ['/*', '!/a/', '/a/b/'], filePath: 'a/c/h', expected: false },
    { lines: ['/d/*'], filePath: 'd/s/g', expected: true },
    { lines: ['/d/*'], filePath: 'top', expected: false },
    { lines: ['/a/**/c'], filePath: 'a/x/y/c', expected: true },
    { lines: ['/a/**/c'], filePath: 'a/x/d', expected: false },
    { lines: ['/a/**', '!/a/b/**'], filePath: 'a/b/c/h', expected: false },
    { lines: ['/a/**', '!/a/b/**'], filePath: 'a/x/y', expected: true },
    { lines: ['/*', '!/*/', '/a/', '!/a/b/', '/a/b/c/'], filePath: 'a/b/c/d/h', expected: true },
    { lines: ['/*', '!/*/', '/a/', '!/a/b/', '/a/b/c/'], filePath: 'a/b/f', expected: false },
    { lines: ['/*', '!/*/', '/a/', '!/a/b/', '/a/b/c/'], filePath: 'z/q', expected: false },
    { lines: ['/*', '!/a/', '/a/keep'], filePath: 'a/keep', expected: true },
    { lines: ['/*', '!/a/', '/a/keep'], filePath: 'a/q/r', expected: false },
    { lines: ['b', '!a/b/c'], filePath: 'a/b/c', expected: false },
    { lines: ['b', '!a/b/c'], filePath: 'a/b/d', expected: true },
    { lines: ['/a/', '!/a/b'], filePath: 'a/b', expected: false },
    { lines: ['/a/', '!/a/b'], filePath: 'a/b/d', expected: false },
    { lines: ['/a/', '!/a/b'], filePath: 'a/x/y', expected: true },
    { lines: ['/d0/', '!/d0/sub/', '/d0/sub/keep'], filePath: 'd0/sub/keep', expected: true },
    { lines: ['/d0/', '!/d0/sub/', '/d0/sub/keep'], filePath: 'd0/sub/keep/z', expected: true },
    { lines: ['/d0/', '!/d0/sub/', '/d0/sub/keep'], filePath: 'd0/sub/y', expected: false },
    { lines: ['/*', '!/d0/', '/d0/keep/'], filePath: 'd0/keep/g', expected: true },
    { lines: ['/*', '!/d0/', '/d0/keep/'], filePath: 'd0/x/y', expected: false },
    { lines: ['/*'], filePath: 'a/f', expected: true },
    { lines: ['/*'], filePath: 'top', expected: true },
    { lines: ['/g', '/dir/'], filePath: 'dir', expected: false },
    { lines: ['/g', '/dir/'], filePath: 'dir/a', expected: true },
    { lines: ['/g', '/dir/'], filePath: 'g', expected: true },
    { lines: ['/g', '/dir/'], filePath: 'other', expected: false },
    { lines: ['/src/*', '!/src/f'], filePath: 'src/f', expected: false },
    { lines: ['/src/*', '!/src/f'], filePath: 'src/d/f', expected: true },
  ])('Given $lines', ({ lines, filePath, expected }) => {
    describe(`When tested against ${filePath}`, () => {
      it(`Then it is ${expected ? 'in' : 'out of'} the sparse set`, () => {
        // Arrange
        const sut = nonConeMatcher(lines.map(rule));

        // Act
        const result = sut(path(filePath));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('nonConeMatcher cost', () => {
  const countingRules = (): { rules: SparseRule[]; evaluations: () => number } => {
    let evaluations = 0;
    const counting = (source: string): SparseRule => ({
      source,
      negated: false,
      directoryOnly: false,
      matcher: {
        test: () => {
          evaluations++;
          return false;
        },
      },
    });
    return { rules: [counting('x'), counting('y'), counting('z')], evaluations: () => evaluations };
  };
  const deep = `${'d/'.repeat(150)}`;

  describe('Given a path 150 directories deep whose levels no rule decides', () => {
    describe('When a sibling of an already judged path is judged', () => {
      it('Then only the leaf is evaluated against the rules', () => {
        // Arrange
        const { rules, evaluations } = countingRules();
        const sut = nonConeMatcher(rules);
        sut(path(`${deep}first`));
        const before = evaluations();

        // Act
        sut(path(`${deep}second`));

        // Assert
        expect(evaluations() - before).toBe(rules.length);
      });
    });

    describe('When the path is judged first', () => {
      it('Then each level is evaluated once', () => {
        // Arrange
        const { rules, evaluations } = countingRules();
        const sut = nonConeMatcher(rules);

        // Act
        sut(path(`${deep}first`));

        // Assert
        expect(evaluations()).toBe(rules.length * 151);
      });
    });

    describe('When a deeper directory under the judged chain is judged', () => {
      it('Then only the new levels are evaluated', () => {
        // Arrange
        const { rules, evaluations } = countingRules();
        const sut = nonConeMatcher(rules);
        sut(path(`${deep}first`));
        const before = evaluations();

        // Act
        sut(path(`${deep}e/second`));

        // Assert
        expect(evaluations() - before).toBe(rules.length * 2);
      });
    });

    describe('When a sibling branch forking one level above the judged leaf directory is judged', () => {
      it('Then the shared ancestors are not evaluated again', () => {
        // Arrange
        const { rules, evaluations } = countingRules();
        const sut = nonConeMatcher(rules);
        sut(path(`${deep}first`));
        const before = evaluations();

        // Act
        sut(path(`${'d/'.repeat(149)}x/second`));

        // Assert
        expect(evaluations() - before).toBe(rules.length * 2);
      });
    });
  });
});

describe('nonConeMatcher with an entry kind', () => {
  describe('Given "sub/" and a gitlink path "sub"', () => {
    const rules = [rule('sub/')];

    describe('When it is judged as a directory', () => {
      it('Then the directory-only rule includes it', () => {
        // Arrange
        const sut = nonConeMatcher(rules);

        // Act
        const result = sut(path('sub'), 'directory');

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When it is judged without a kind', () => {
      it('Then it is a file and the directory-only rule leaves it out', () => {
        // Arrange
        const sut = nonConeMatcher(rules);

        // Act
        const result = sut(path('sub'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given "*" then "!sub/" and a gitlink path "sub"', () => {
    const rules = [rule('*'), rule('!sub/')];

    describe('When it is judged as a directory', () => {
      it('Then the negated directory-only rule excludes it', () => {
        // Arrange
        const sut = nonConeMatcher(rules);

        // Act
        const result = sut(path('sub'), 'directory');

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When it is judged as a file', () => {
      it('Then the negated directory-only rule does not apply', () => {
        // Arrange
        const sut = nonConeMatcher(rules);

        // Act
        const result = sut(path('sub'), 'file');

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});

describe('compileSparseRule with escapes', () => {
  describe('Given an escaped sparse rule', () => {
    describe('When compiled', () => {
      it.each([
        { line: '\\*', path: 'x', expected: false },
        { line: '\\*', path: '*', expected: true },
        { line: '\\[a]', path: '[a]', expected: true },
        { line: '\\[a]', path: 'a', expected: false },
        { line: 'a\\', path: 'a\\', expected: false },
      ])('Then $line matches $path as $expected', ({ line, path: candidate, expected }) => {
        // Arrange
        const sut = rule;

        // Act
        const result = sut(line).matcher.test(candidate);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
