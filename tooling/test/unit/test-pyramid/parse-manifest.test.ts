import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../../test-pyramid/parse-manifest.js';

const VALID_MANIFEST = {
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
      regex: '\\bvi\\.(mock|fn|spyOn|stubGlobal|stubEnv)\\s*\\(',
      threshold: 0,
    },
    underAssertedUnit: {
      tier: 'unit',
      minAssertionsPerTest: 1,
    },
    gwtTitle: {
      tier: 'unit',
      regex: '^Given .+?, When .+?, Then .+$',
    },
    aaaBody: {
      tier: 'unit',
      required: ['Arrange', 'Assert'],
    },
    sutNaming: {
      tier: 'unit',
      banned: ['subject', 'objectUnderTest', 'systemUnderTest', 'cut'],
    },
    bareClassToThrow: {
      tier: 'unit',
      regex: '\\.toThrow(?:Error)?\\s*\\(\\s*([A-Z]\\w*)\\s*\\)',
    },
    emptyAaaSection: {
      tier: 'unit',
    },
  },
};

const replaceHeuristic = (
  base: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> => {
  const heuristics = { ...(base.heuristics as Record<string, unknown>) };
  if (value === undefined) {
    delete heuristics[key];
  } else {
    heuristics[key] = value;
  }
  return { ...base, heuristics };
};

describe('parseManifest', () => {
  describe('happy path', () => {
    it('Given a well-formed manifest JSON string, When parsed, Then returns a typed PyramidManifest', () => {
      // Arrange
      const raw = JSON.stringify(VALID_MANIFEST);

      // Act
      const sut = parseManifest(raw);

      // Assert
      expect(sut.tiers).toHaveLength(3);
      expect(sut.tiers[0]?.name).toBe('unit');
      expect(sut.tiers[1]?.name).toBe('integration');
      expect(sut.tiers[2]?.name).toBe('e2e');
      expect(sut.heuristics.overMockedIntegration.threshold).toBe(0);
      expect(sut.heuristics.underAssertedUnit.minAssertionsPerTest).toBe(1);
    });

    it('Given a manifest with a $schema field, When parsed, Then $schema is ignored and parsing succeeds', () => {
      // Arrange
      const raw = JSON.stringify({
        $schema: './tooling/test-pyramid-budgets-schema.json',
        ...VALID_MANIFEST,
      });

      // Act
      const sut = parseManifest(raw);

      // Assert
      expect(sut.tiers).toHaveLength(3);
    });

    it('Given a heuristic regex, When parsed, Then the compiled RegExp is exposed', () => {
      // Arrange
      const raw = JSON.stringify(VALID_MANIFEST);

      // Act
      const sut = parseManifest(raw);

      // Assert
      const re = sut.heuristics.overMockedIntegration.compiledRegex;
      expect(re).toBeInstanceOf(RegExp);
      expect(re.test('vi.mock("foo")')).toBe(true);
      expect(re.test('vi.useFakeTimers()')).toBe(false);
    });
  });

  describe('failure modes', () => {
    it('Given a non-JSON string, When parsed, Then throws with "manifest invalid: not valid JSON"', () => {
      // Arrange
      const raw = '{not valid json';

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('manifest invalid');
      expect(caught?.message).toContain('not valid JSON');
    });

    it('Given a manifest missing the tiers field, When parsed, Then throws naming "tiers"', () => {
      // Arrange
      const raw = JSON.stringify({ heuristics: VALID_MANIFEST.heuristics });

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('tiers');
    });

    it('Given a manifest with an empty tiers array, When parsed, Then throws "tiers must contain at least one entry"', () => {
      // Arrange
      const raw = JSON.stringify({ ...VALID_MANIFEST, tiers: [] });

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('tiers must contain at least one entry');
    });

    it('Given a tier where target is not a number 0..100, When parsed, Then throws naming the field', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        tiers: [
          { ...VALID_MANIFEST.tiers[0], target: 150 },
          VALID_MANIFEST.tiers[1],
          VALID_MANIFEST.tiers[2],
        ],
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('target');
      expect(caught?.message).toContain('0..100');
    });

    it('Given a tier where warnBelow is greater than target, When parsed, Then throws "warnBelow must be <= target"', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        tiers: [
          { ...VALID_MANIFEST.tiers[0], target: 50, warnBelow: 90 },
          VALID_MANIFEST.tiers[1],
          VALID_MANIFEST.tiers[2],
        ],
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('warnBelow must be <= target');
    });

    it('Given a tier where warnAbove is less than target, When parsed, Then throws "warnAbove must be >= target"', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        tiers: [
          VALID_MANIFEST.tiers[0],
          { ...VALID_MANIFEST.tiers[1], target: 80, warnAbove: 50 },
          VALID_MANIFEST.tiers[2],
        ],
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('warnAbove must be >= target');
    });

    it('Given a manifest with duplicate tier names, When parsed, Then throws "duplicate tier name"', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        tiers: [
          VALID_MANIFEST.tiers[0],
          { ...VALID_MANIFEST.tiers[1], name: 'unit' },
          VALID_MANIFEST.tiers[2],
        ],
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('duplicate tier name');
      expect(caught?.message).toContain('unit');
    });

    it('Given a heuristic regex that fails to compile, When parsed, Then throws "heuristic regex invalid"', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          overMockedIntegration: {
            ...VALID_MANIFEST.heuristics.overMockedIntegration,
            regex: '(unbalanced',
          },
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('heuristic regex invalid');
      expect(caught?.message).toContain('overMockedIntegration');
    });

    it('Given a heuristic whose tier does not exist, When parsed, Then throws naming the unknown tier', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          overMockedIntegration: {
            ...VALID_MANIFEST.heuristics.overMockedIntegration,
            tier: 'phantom',
          },
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('phantom');
      expect(caught?.message).toContain('unknown tier');
    });

    it('Given a manifest missing the heuristics block, When parsed, Then throws "heuristics block is required"', () => {
      // Arrange
      const raw = JSON.stringify({ tiers: VALID_MANIFEST.tiers });

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('heuristics block is required');
    });

    it('Given a tier where warnAbove is omitted from the JSON, When parsed, Then warnAbove parses as null (undefined arm of the guard)', () => {
      // Arrange — explicit `null` is the happy path; this verifies the
      // omission arm of `warnAbove === null || warnAbove === undefined`.
      const broken = {
        ...VALID_MANIFEST,
        tiers: [
          { name: 'unit', glob: 'test/unit/**/*.test.ts', target: 80, warnBelow: 75 },
          VALID_MANIFEST.tiers[1],
          VALID_MANIFEST.tiers[2],
        ],
      };
      const raw = JSON.stringify(broken);

      // Act
      const sut = parseManifest(raw);

      // Assert
      expect(sut.tiers[0]?.warnAbove).toBeNull();
    });

    it('Given a heuristics block that is not an object (a number), When parsed, Then throws "heuristics block is required"', () => {
      // Arrange — exercises the isObject() guard on heuristics itself
      // (distinct from the `=== undefined` shortcut on inner heuristic keys).
      const broken = { tiers: VALID_MANIFEST.tiers, heuristics: 42 };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('heuristics block is required');
    });

    it('Given a heuristic with minAssertionsPerTest that is a non-integer number (1.5), When parsed, Then throws naming the field', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          underAssertedUnit: { tier: 'unit', minAssertionsPerTest: 1.5 },
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('minAssertionsPerTest');
      expect(caught?.message).toContain('integer');
    });

    it('Given a heuristic with minAssertionsPerTest below 1, When parsed, Then throws naming the field', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          underAssertedUnit: { tier: 'unit', minAssertionsPerTest: 0 },
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('minAssertionsPerTest');
      expect(caught?.message).toContain('>= 1');
    });

    it('Given a manifest where overMockedIntegration is missing, When parsed, Then throws naming the missing heuristic', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: { underAssertedUnit: VALID_MANIFEST.heuristics.underAssertedUnit },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('overMockedIntegration');
    });

    it('Given a tier whose warnAbove is a string, When parsed, Then throws "warnAbove must be a number 0..100 or null"', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        tiers: [
          VALID_MANIFEST.tiers[0],
          { ...VALID_MANIFEST.tiers[1], warnAbove: 'oops' as unknown as number },
          VALID_MANIFEST.tiers[2],
        ],
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('warnAbove must be a number 0..100 or null');
    });

    it('Given a tier whose warnBelow is greater than 100, When parsed, Then throws naming warnBelow', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        tiers: [
          { ...VALID_MANIFEST.tiers[0], target: 50, warnBelow: 200 },
          VALID_MANIFEST.tiers[1],
          VALID_MANIFEST.tiers[2],
        ],
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('warnBelow must be a number 0..100');
    });

    it('Given a tier with a numeric name, When parsed, Then throws "tier name must be a non-empty string"', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        tiers: [
          { ...VALID_MANIFEST.tiers[0], name: 42 as unknown as string },
          VALID_MANIFEST.tiers[1],
          VALID_MANIFEST.tiers[2],
        ],
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('name must be a non-empty string');
    });

    it('Given a tier with an empty glob string, When parsed, Then throws naming glob', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        tiers: [
          { ...VALID_MANIFEST.tiers[0], glob: '' },
          VALID_MANIFEST.tiers[1],
          VALID_MANIFEST.tiers[2],
        ],
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('glob must be a non-empty string');
    });

    it('Given a tier definition that is a string instead of an object, When parsed, Then throws "tier #0 must be an object"', () => {
      // Arrange
      const broken = { ...VALID_MANIFEST, tiers: ['not-an-object'] };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('tier #0 must be an object');
    });

    it('Given overMockedIntegration as a string instead of an object, When parsed, Then throws "overMockedIntegration must be an object"', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          overMockedIntegration: 'not-an-object' as unknown as Record<string, unknown>,
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('overMockedIntegration must be an object');
    });

    it('Given overMockedIntegration with negative threshold, When parsed, Then throws naming threshold', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          overMockedIntegration: {
            ...VALID_MANIFEST.heuristics.overMockedIntegration,
            threshold: -1,
          },
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('threshold must be a number >= 0');
    });

    it('Given overMockedIntegration with empty tier string, When parsed, Then throws naming tier', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          overMockedIntegration: {
            ...VALID_MANIFEST.heuristics.overMockedIntegration,
            tier: '',
          },
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('tier must be a non-empty string');
    });

    it('Given overMockedIntegration with empty regex, When parsed, Then throws naming regex', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          overMockedIntegration: {
            ...VALID_MANIFEST.heuristics.overMockedIntegration,
            regex: '',
          },
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('regex must be a non-empty string');
    });

    it('Given underAssertedUnit as a string instead of an object, When parsed, Then throws "underAssertedUnit must be an object"', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          underAssertedUnit: 'not-an-object' as unknown as Record<string, unknown>,
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('underAssertedUnit must be an object');
    });

    it('Given underAssertedUnit referencing an unknown tier, When parsed, Then throws naming the tier', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          underAssertedUnit: { tier: 'phantom', minAssertionsPerTest: 1 },
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('phantom');
      expect(caught?.message).toContain('unknown tier');
    });

    it('Given underAssertedUnit with empty tier string, When parsed, Then throws naming tier', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: {
          ...VALID_MANIFEST.heuristics,
          underAssertedUnit: { tier: '', minAssertionsPerTest: 1 },
        },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('tier must be a non-empty string');
    });

    it('Given a top-level non-object JSON value (a number), When parsed, Then throws "top-level value must be an object"', () => {
      // Arrange
      const raw = '42';

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('top-level value must be an object');
    });

    it('Given a manifest where underAssertedUnit is missing, When parsed, Then throws naming the missing heuristic', () => {
      // Arrange
      const broken = {
        ...VALID_MANIFEST,
        heuristics: { overMockedIntegration: VALID_MANIFEST.heuristics.overMockedIntegration },
      };
      const raw = JSON.stringify(broken);

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('underAssertedUnit');
    });
  });

  describe('expressiveness heuristics — happy path', () => {
    it('Given the gwtTitle heuristic, When parsed, Then the compiled RegExp matches a GWT title', () => {
      // Arrange
      const raw = JSON.stringify(VALID_MANIFEST);

      // Act
      const sut = parseManifest(raw);

      // Assert
      const re = sut.heuristics.gwtTitle.compiledRegex;
      expect(re).toBeInstanceOf(RegExp);
      const fresh = new RegExp(sut.heuristics.gwtTitle.regex);
      expect(fresh.test('Given a, When b, Then c')).toBe(true);
      expect(fresh.test('it works')).toBe(false);
    });

    it('Given the aaaBody heuristic, When parsed, Then required is the preserved array', () => {
      // Arrange
      const raw = JSON.stringify(VALID_MANIFEST);

      // Act
      const sut = parseManifest(raw);

      // Assert
      expect(sut.heuristics.aaaBody.required).toEqual(['Arrange', 'Assert']);
    });

    it('Given the sutNaming heuristic, When parsed, Then banned is the preserved list', () => {
      // Arrange
      const raw = JSON.stringify(VALID_MANIFEST);

      // Act
      const sut = parseManifest(raw);

      // Assert
      expect(sut.heuristics.sutNaming.banned).toEqual([
        'subject',
        'objectUnderTest',
        'systemUnderTest',
        'cut',
      ]);
    });

    it('Given the bareClassToThrow heuristic, When parsed, Then the compiled RegExp catches PascalCase identifiers', () => {
      // Arrange
      const raw = JSON.stringify(VALID_MANIFEST);

      // Act
      const sut = parseManifest(raw);

      // Assert
      const fresh = new RegExp(sut.heuristics.bareClassToThrow.regex);
      expect(fresh.test('.toThrow(TsgitError)')).toBe(true);
      expect(fresh.test(".toThrow('msg')")).toBe(false);
      expect(fresh.test('.toThrow(/re/)')).toBe(false);
    });
  });

  describe('expressiveness heuristics — failure modes', () => {
    it('Given gwtTitle missing, When parsed, Then throws naming gwtTitle', () => {
      // Arrange
      const raw = JSON.stringify(replaceHeuristic(VALID_MANIFEST, 'gwtTitle', undefined));

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('heuristics.gwtTitle is required');
    });

    it('Given gwtTitle as a string instead of an object, When parsed, Then throws naming gwtTitle', () => {
      // Arrange
      const raw = JSON.stringify(replaceHeuristic(VALID_MANIFEST, 'gwtTitle', 'oops'));

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('gwtTitle must be an object');
    });

    it('Given gwtTitle with an invalid regex, When parsed, Then throws "heuristic regex invalid (gwtTitle)"', () => {
      // Arrange
      const raw = JSON.stringify(
        replaceHeuristic(VALID_MANIFEST, 'gwtTitle', { tier: 'unit', regex: '[' }),
      );

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('heuristic regex invalid (gwtTitle)');
    });

    it('Given aaaBody with required containing an unknown marker, When parsed, Then throws naming the bad marker', () => {
      // Arrange
      const raw = JSON.stringify(
        replaceHeuristic(VALID_MANIFEST, 'aaaBody', {
          tier: 'unit',
          required: ['Arrange', 'Bogus'],
        }),
      );

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('aaaBody required entry "Bogus"');
    });

    it('Given aaaBody required as an empty array, When parsed, Then throws naming required', () => {
      // Arrange
      const raw = JSON.stringify(
        replaceHeuristic(VALID_MANIFEST, 'aaaBody', { tier: 'unit', required: [] }),
      );

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('aaaBody required must be a non-empty array');
    });

    it('Given aaaBody required with duplicates, When parsed, Then throws naming the duplicate', () => {
      // Arrange
      const raw = JSON.stringify(
        replaceHeuristic(VALID_MANIFEST, 'aaaBody', {
          tier: 'unit',
          required: ['Arrange', 'Arrange'],
        }),
      );

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('aaaBody required has duplicate "Arrange"');
    });

    it('Given sutNaming with an empty banned list, When parsed, Then throws naming banned', () => {
      // Arrange
      const raw = JSON.stringify(
        replaceHeuristic(VALID_MANIFEST, 'sutNaming', { tier: 'unit', banned: [] }),
      );

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('sutNaming banned must be a non-empty array');
    });

    it('Given sutNaming with a non-identifier entry, When parsed, Then throws naming the bad entry', () => {
      // Arrange
      const raw = JSON.stringify(
        replaceHeuristic(VALID_MANIFEST, 'sutNaming', {
          tier: 'unit',
          banned: ['ok', '1nope'],
        }),
      );

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('sutNaming banned entry "1nope"');
    });

    it('Given sutNaming banned with a duplicate, When parsed, Then throws naming the duplicate', () => {
      // Arrange
      const raw = JSON.stringify(
        replaceHeuristic(VALID_MANIFEST, 'sutNaming', {
          tier: 'unit',
          banned: ['x', 'x'],
        }),
      );

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('sutNaming banned has duplicate "x"');
    });

    it('Given bareClassToThrow as a non-object, When parsed, Then throws naming bareClassToThrow', () => {
      // Arrange
      const raw = JSON.stringify(replaceHeuristic(VALID_MANIFEST, 'bareClassToThrow', 42));

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('bareClassToThrow must be an object');
    });

    it('Given bareClassToThrow with an unknown tier, When parsed, Then throws naming the tier', () => {
      // Arrange
      const raw = JSON.stringify(
        replaceHeuristic(VALID_MANIFEST, 'bareClassToThrow', {
          tier: 'ghost',
          regex: '.+',
        }),
      );

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('unknown tier "ghost"');
    });

    it('Given sutNaming as a non-object, When parsed, Then throws naming sutNaming', () => {
      // Arrange
      const raw = JSON.stringify(replaceHeuristic(VALID_MANIFEST, 'sutNaming', null));

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('sutNaming must be an object');
    });

    it('Given aaaBody as a non-object, When parsed, Then throws naming aaaBody', () => {
      // Arrange
      const raw = JSON.stringify(replaceHeuristic(VALID_MANIFEST, 'aaaBody', 'oops'));

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('aaaBody must be an object');
    });

    it('Given emptyAaaSection missing entirely, When parsed, Then throws naming the required key', () => {
      // Arrange
      const raw = JSON.stringify(replaceHeuristic(VALID_MANIFEST, 'emptyAaaSection', undefined));

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('heuristics.emptyAaaSection is required');
    });

    it('Given emptyAaaSection as a non-object, When parsed, Then throws naming emptyAaaSection', () => {
      // Arrange
      const raw = JSON.stringify(replaceHeuristic(VALID_MANIFEST, 'emptyAaaSection', 7));

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('emptyAaaSection must be an object');
    });

    it('Given emptyAaaSection with an unknown tier, When parsed, Then throws naming the tier', () => {
      // Arrange
      const raw = JSON.stringify(
        replaceHeuristic(VALID_MANIFEST, 'emptyAaaSection', { tier: 'ghost' }),
      );

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('unknown tier "ghost"');
    });
  });

  describe('gating block', () => {
    it('Given a manifest without a gating object, When parsed, Then gating defaults all keys to false', () => {
      // Arrange
      const raw = JSON.stringify(VALID_MANIFEST);

      // Act
      const sut = parseManifest(raw);

      // Assert
      expect(sut.gating).toEqual({
        overMockedIntegration: false,
        underAssertedUnit: false,
        gwtTitle: false,
        aaaBody: false,
        sutNaming: false,
        bareClassToThrow: false,
        emptyAaaSection: false,
      });
    });

    it('Given gating with partial keys set true, When parsed, Then unspecified keys default to false', () => {
      // Arrange
      const raw = JSON.stringify({
        ...VALID_MANIFEST,
        gating: { gwtTitle: true, sutNaming: true },
      });

      // Act
      const sut = parseManifest(raw);

      // Assert
      expect(sut.gating.gwtTitle).toBe(true);
      expect(sut.gating.sutNaming).toBe(true);
      expect(sut.gating.aaaBody).toBe(false);
      expect(sut.gating.bareClassToThrow).toBe(false);
      expect(sut.gating.underAssertedUnit).toBe(false);
      expect(sut.gating.overMockedIntegration).toBe(false);
      expect(sut.gating.emptyAaaSection).toBe(false);
    });

    it('Given gating.emptyAaaSection set true, When parsed, Then that gate is enabled', () => {
      // Arrange
      const raw = JSON.stringify({
        ...VALID_MANIFEST,
        gating: { emptyAaaSection: true },
      });

      // Act
      const sut = parseManifest(raw);

      // Assert
      expect(sut.gating.emptyAaaSection).toBe(true);
    });

    it('Given gating referencing an unknown heuristic, When parsed, Then throws naming the unknown key', () => {
      // Arrange
      const raw = JSON.stringify({ ...VALID_MANIFEST, gating: { mystery: true } });

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('unknown heuristic "mystery"');
    });

    it('Given gating with a non-boolean value, When parsed, Then throws naming the key', () => {
      // Arrange
      const raw = JSON.stringify({
        ...VALID_MANIFEST,
        gating: { gwtTitle: 'yes' },
      });

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('gating "gwtTitle" must be a boolean');
    });

    it('Given gating as a string instead of an object, When parsed, Then throws naming gating', () => {
      // Arrange
      const raw = JSON.stringify({ ...VALID_MANIFEST, gating: 'all' });

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('gating must be an object');
    });
  });

  describe('excludePaths block', () => {
    it('Given a manifest without an excludePaths array, When parsed, Then excludePaths defaults to []', () => {
      // Arrange
      const raw = JSON.stringify(VALID_MANIFEST);

      // Act
      const sut = parseManifest(raw);

      // Assert
      expect(sut.excludePaths).toEqual([]);
    });

    it('Given excludePaths with valid tooling/test/ entries, When parsed, Then they are returned verbatim', () => {
      // Arrange
      const raw = JSON.stringify({
        ...VALID_MANIFEST,
        excludePaths: [
          'tooling/test/unit/test-pyramid/detect-bad-title.test.ts',
          'tooling/test/integration/audit-test-pyramid.test.ts',
        ],
      });

      // Act
      const sut = parseManifest(raw);

      // Assert
      expect(sut.excludePaths).toEqual([
        'tooling/test/unit/test-pyramid/detect-bad-title.test.ts',
        'tooling/test/integration/audit-test-pyramid.test.ts',
      ]);
    });

    it('Given excludePaths as a non-array value, When parsed, Then throws naming excludePaths', () => {
      // Arrange
      const raw = JSON.stringify({ ...VALID_MANIFEST, excludePaths: 'tooling/test/x' });

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('excludePaths must be an array');
    });

    it('Given an excludePaths entry that is an empty string, When parsed, Then throws naming the entry', () => {
      // Arrange
      const raw = JSON.stringify({ ...VALID_MANIFEST, excludePaths: [''] });

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('excludePaths entry must be a non-empty string');
    });

    it('Given an excludePaths entry outside tooling/test/, When parsed, Then throws naming the violating prefix', () => {
      // Arrange — `src/...` is a real product path; silencing it via excludePaths would gut the lint.
      const raw = JSON.stringify({
        ...VALID_MANIFEST,
        excludePaths: ['src/domain/error.test.ts'],
      });

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('src/domain/error.test.ts');
      expect(caught?.message).toContain('tooling/test/');
    });

    it('Given an excludePaths entry under test/unit/ (not tooling/test/), When parsed, Then throws naming the prefix', () => {
      // Arrange — adjacent but distinct prefix; documents why the check exists.
      const raw = JSON.stringify({
        ...VALID_MANIFEST,
        excludePaths: ['test/unit/domain/objects/object-id.test.ts'],
      });

      // Act
      let caught: Error | undefined;
      try {
        parseManifest(raw);
      } catch (error) {
        caught = error instanceof Error ? error : undefined;
      }

      // Assert
      expect(caught?.message).toContain('test/unit/domain/objects/object-id.test.ts');
      expect(caught?.message).toContain('tooling/test/');
    });
  });
});
