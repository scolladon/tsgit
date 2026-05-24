import { describe, expect, it } from 'vitest';
import { detectUnderAsserted } from '../../../../scripts/test-pyramid/detect-under-asserted.js';
import type { PyramidManifest } from '../../../../scripts/test-pyramid/parse-manifest.js';

const MANIFEST: PyramidManifest = {
  tiers: [
    {
      name: 'unit',
      glob: 'test/unit/**/*.test.ts',
      target: 80,
      warnBelow: 75,
      warnAbove: null,
    },
    {
      name: 'integration',
      glob: 'test/integration/**/*.test.ts',
      target: 15,
      warnBelow: 10,
      warnAbove: 25,
    },
    {
      name: 'e2e',
      glob: 'test/browser/**/*.spec.ts',
      target: 5,
      warnBelow: 3,
      warnAbove: null,
    },
  ],
  heuristics: {
    overMockedIntegration: {
      tier: 'integration',
      regex: 'x',
      compiledRegex: /x/g,
      threshold: 0,
    },
    underAssertedUnit: { tier: 'unit', minAssertionsPerTest: 1 },
  },
};

const file = (path: string, source: string) => ({ path, source });

describe('detectUnderAsserted', () => {
  it('Given a unit it() block with one expect() call, When scanned, Then no finding is returned', () => {
    // Arrange
    const source = `
import { describe, expect, it } from 'vitest';
describe('a', () => {
  it('title', () => {
    expect(1).toBe(1);
  });
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a unit it() block with zero assertions, When scanned, Then one finding with path/line/title is returned', () => {
    // Arrange — leading newline = line 1, import = line 2, describe = line 3,
    // inner it() opens on line 4.
    const source = `
import { describe, it } from 'vitest';
describe('a', () => {
  it('does nothing', () => {
    const x = 1;
  });
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([{ path: 'test/unit/a.test.ts', line: 4, title: 'does nothing' }]);
  });

  it('Given an it.skip block with zero assertions, When scanned, Then no finding (skip exempt)', () => {
    // Arrange
    const source = `
import { it } from 'vitest';
it.skip('skipped test', () => {
  // intentionally empty
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an it.todo block with no body, When scanned, Then no finding (todo exempt)', () => {
    // Arrange
    const source = `
import { it } from 'vitest';
it.todo('write this later');
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an it.fails block with zero assertions, When scanned, Then no finding (fails exempt)', () => {
    // Arrange
    const source = `
import { it } from 'vitest';
it.fails('always fails on purpose', () => {
  throw new Error('boom');
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given nested describe blocks each with an it(), When scanned, Then each inner it is scanned independently', () => {
    // Arrange
    const source = `
describe('outer', () => {
  describe('inner-a', () => {
    it('a1', () => {
      expect(1).toBe(1);
    });
    it('a2', () => {
      const x = 1;
    });
  });
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('a2');
  });

  it('Given an it.each(...) block with one expect(), When scanned, Then no finding (counted as one test)', () => {
    // Arrange
    const source = `
it.each([1, 2, 3])('case %s', (n) => {
  expect(n).toBeGreaterThan(0);
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a multi-line it() opener, When scanned, Then the body assertions are still counted', () => {
    // Arrange
    const source = `
it(
  'long title spanning lines',
  async () => {
    expect(1).toBe(1);
  },
);
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a body that calls helper-prefixed expectFoo(...), When scanned, Then the regex matches and no finding is reported', () => {
    // Arrange
    const source = `
it('uses helper', () => {
  expectGitObject(x);
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a body that calls a helper-prefixed assertXxx(...) (project convention), When scanned, Then the regex matches and no finding is reported', () => {
    // Arrange
    const source = `
it('uses assertion helper', () => {
  assertRefspecInvalid(() => parse('+'), 'after force prefix');
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a body that uses node:assert (assert.equal), When scanned, Then the regex matches and no finding is reported', () => {
    // Arrange
    const source = `
it('uses node assert', () => {
  assert.equal(1, 1);
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a body that uses expectTypeOf<T>() with generic args, When scanned, Then the regex matches and no finding is reported', () => {
    // Arrange
    const source = `
it('type-level test', () => {
  expectTypeOf<number>().toExtend<Awaitable<number>>();
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a body that uses expectTypeOf<Promise<T>>() with nested generic args, When scanned, Then the regex matches and no finding is reported', () => {
    // Arrange
    const source = `
it('nested generics', () => {
  expectTypeOf<Promise<string>>().toExtend<Awaitable<string>>();
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a body where a local variable is named `expected` (not an assertion call), When scanned, Then it is not mistaken for an assertion', () => {
    // Arrange — `const expected = …` must not satisfy the heuristic.
    const source = `
it('uses local named expected', () => {
  const expected = 1;
  void expected;
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert — no assertion call → finding emitted.
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('uses local named expected');
  });

  it('Given a unit test whose body calls a method named test() (e.g. regex.test()), When scanned, Then the method call is not mistaken for a vitest test opener', () => {
    // Arrange — `compiled.test('lib/foo.ts')` must not be classified as a
    // nested vitest test block. The outer it() has assertions; no finding.
    const source = `
it('pathspec regex check', () => {
  expect(compiled.test('lib/foo.ts')).toBe(true);
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a test() block (vitest test alias) with zero assertions, When scanned, Then a finding is reported', () => {
    // Arrange
    const source = `
test('empty test', () => {
  // nothing
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('empty test');
  });

  it('Given a non-unit-tier file (integration) with zero assertions, When scanned, Then no finding (heuristic scoped to unit)', () => {
    // Arrange
    const source = `
it('empty', () => {});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/integration/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given findings across multiple files, When scanned, Then findings are sorted by path then by line', () => {
    // Arrange
    const sourceA = `
it('zero', () => {});
`;
    const sourceB = `
it('also zero', () => {});
it('second', () => {});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [
      file('test/unit/b.test.ts', sourceB),
      file('test/unit/a.test.ts', sourceA),
    ]);

    // Assert
    expect(sut.map((f) => f.path)).toEqual([
      'test/unit/a.test.ts',
      'test/unit/b.test.ts',
      'test/unit/b.test.ts',
    ]);
    const second = sut[1]?.line;
    const third = sut[2]?.line;
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    expect(second).toBeLessThan(third as number);
  });

  it('Given a test using a template literal title with zero assertions, When scanned, Then a finding is reported with the literal text', () => {
    // Arrange
    const source = `
it(\`backtick title\`, () => {
  const x = 1;
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('backtick title');
  });

  it('Given a single-expression arrow body without braces (`() => expect(x).toBe(y)`), When scanned, Then no finding', () => {
    // Arrange
    const source = `
it('arrow expression body', () => expect(1).toBe(1));
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a test whose title string contains "expect(" literally, When scanned, Then the title text does not satisfy the assertion-count (one finding)', () => {
    // Arrange — the title contains expect(1) but the body has no real assertion.
    const source = `
it('expect(1)', () => {
  const x = 1;
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('expect(1)');
  });

  it('Given a heuristic where minAssertionsPerTest is 2, When the test has exactly one assertion, Then a finding is reported', () => {
    // Arrange
    const stricter: PyramidManifest = {
      ...MANIFEST,
      heuristics: {
        ...MANIFEST.heuristics,
        underAssertedUnit: { tier: 'unit', minAssertionsPerTest: 2 },
      },
    };
    const source = `
it('only one assert', () => {
  expect(1).toBe(1);
});
`;

    // Act
    const sut = detectUnderAsserted(stricter, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('only one assert');
  });

  it('Given a heuristic where minAssertionsPerTest is 2, When the test has exactly two assertions, Then no finding (boundary case)', () => {
    // Arrange
    const stricter: PyramidManifest = {
      ...MANIFEST,
      heuristics: {
        ...MANIFEST.heuristics,
        underAssertedUnit: { tier: 'unit', minAssertionsPerTest: 2 },
      },
    };
    const source = `
it('two asserts', () => {
  expect(1).toBe(1);
  expect(2).toBe(2);
});
`;

    // Act
    const sut = detectUnderAsserted(stricter, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a file fixture, When the empty-body it lives at line 3, Then the finding reports line 3 exactly', () => {
    // Arrange — line 1 is empty (the leading \n), line 2 is the import line,
    // line 3 is the `it(...)` opener.
    const source = `
import { it } from 'vitest';
it('empty', () => {});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.line).toBe(3);
  });

  it('Given an empty file list, When scanned, Then an empty array is returned', () => {
    // Arrange + Act
    const sut = detectUnderAsserted(MANIFEST, []);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an it.each(...) followed by no second call, When scanned, Then the block is skipped silently (isEach guard)', () => {
    // Arrange — `it.each([])` is invalid in real vitest, but the scanner must
    // skip it rather than crash. Test contains another well-formed it() to
    // confirm scanning continues past the malformed each.
    const source = `
it.each([1, 2, 3]);
it('valid', () => {
  expect(1).toBe(1);
});
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an it.each(...) with an unbalanced inner call, When scanned, Then the block is skipped silently', () => {
    // Arrange — second call opens but never closes.
    const source = `
it.each([1, 2])('case %s', (n) => { expect(n).toBeGreaterThan(0);
`;

    // Act
    const sut = detectUnderAsserted(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert — no crash, no finding emitted (block dropped).
    expect(sut).toEqual([]);
  });
});
