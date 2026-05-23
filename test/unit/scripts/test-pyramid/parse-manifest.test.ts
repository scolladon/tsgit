import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../../../scripts/test-pyramid/parse-manifest.js';

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
  },
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
        $schema: './scripts/test-pyramid-budgets-schema.json',
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
});
