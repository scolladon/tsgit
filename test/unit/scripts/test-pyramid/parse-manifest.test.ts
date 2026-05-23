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
        caught = error as Error;
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
        caught = error as Error;
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
        caught = error as Error;
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
        caught = error as Error;
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
        caught = error as Error;
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
        caught = error as Error;
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
        caught = error as Error;
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
        caught = error as Error;
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
        caught = error as Error;
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
        caught = error as Error;
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
        caught = error as Error;
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
        caught = error as Error;
      }

      // Assert
      expect(caught?.message).toContain('overMockedIntegration');
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
        caught = error as Error;
      }

      // Assert
      expect(caught?.message).toContain('underAssertedUnit');
    });
  });
});
