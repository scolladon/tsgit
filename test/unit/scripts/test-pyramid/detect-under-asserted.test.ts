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
    // Arrange
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
    expect(sut).toHaveLength(1);
    expect(sut[0]?.path).toBe('test/unit/a.test.ts');
    expect(sut[0]?.title).toBe('does nothing');
    expect(sut[0]?.line).toBeGreaterThan(0);
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
    expect(sut[1]?.line).toBeLessThan(sut[2]!.line);
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

  it('Given an empty file list, When scanned, Then an empty array is returned', () => {
    // Arrange + Act
    const sut = detectUnderAsserted(MANIFEST, []);

    // Assert
    expect(sut).toEqual([]);
  });
});
