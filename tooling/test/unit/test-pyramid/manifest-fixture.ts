/**
 * Shared PyramidManifest fixture for test-pyramid unit tests.
 *
 * Returns a fully-populated manifest with sensible defaults for every
 * heuristic and the gating block, so individual tests only need to spell
 * out the bits they care about. Mirrors the runtime
 * `test-pyramid-budgets.json` layout.
 */
import type {
  AaaMarker,
  GatingConfig,
  PyramidManifest,
  TierDefinition,
} from '../../../test-pyramid/parse-manifest.js';

interface ManifestOverrides {
  readonly tiers?: ReadonlyArray<TierDefinition>;
  readonly overMockedRegex?: string;
  readonly underAssertedMin?: number;
  readonly gwtTitleRegex?: string;
  readonly aaaRequired?: ReadonlyArray<AaaMarker>;
  readonly sutBanned?: ReadonlyArray<string>;
  readonly bareClassRegex?: string;
  readonly gating?: Partial<GatingConfig>;
}

const DEFAULT_TIERS: ReadonlyArray<TierDefinition> = [
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
];

const DEFAULT_OVER_MOCKED_REGEX = '\\bvi\\.(mock|fn|spyOn|stubGlobal|stubEnv)\\s*\\(';
const DEFAULT_GWT_REGEX = '^Given .+?, When .+?, Then .+$';
const DEFAULT_BARE_CLASS_REGEX = '\\.toThrow(?:Error)?\\s*\\(\\s*([A-Z]\\w*)\\s*\\)';

const DEFAULT_GATING: GatingConfig = {
  overMockedIntegration: false,
  underAssertedUnit: false,
  gwtTitle: false,
  aaaBody: false,
  sutNaming: false,
  bareClassToThrow: false,
};

export const makeManifest = (overrides: ManifestOverrides = {}): PyramidManifest => {
  const overMockedRegex = overrides.overMockedRegex ?? DEFAULT_OVER_MOCKED_REGEX;
  const gwtRegex = overrides.gwtTitleRegex ?? DEFAULT_GWT_REGEX;
  const bareClassRegex = overrides.bareClassRegex ?? DEFAULT_BARE_CLASS_REGEX;

  return {
    tiers: overrides.tiers ?? DEFAULT_TIERS,
    heuristics: {
      overMockedIntegration: {
        tier: 'integration',
        regex: overMockedRegex,
        compiledRegex: new RegExp(overMockedRegex, 'g'),
        threshold: 0,
      },
      underAssertedUnit: {
        tier: 'unit',
        minAssertionsPerTest: overrides.underAssertedMin ?? 1,
      },
      gwtTitle: {
        tier: 'unit',
        regex: gwtRegex,
        compiledRegex: new RegExp(gwtRegex, 'g'),
      },
      aaaBody: {
        tier: 'unit',
        required: overrides.aaaRequired ?? ['Arrange', 'Assert'],
      },
      sutNaming: {
        tier: 'unit',
        banned: overrides.sutBanned ?? ['subject', 'objectUnderTest', 'systemUnderTest', 'cut'],
      },
      bareClassToThrow: {
        tier: 'unit',
        regex: bareClassRegex,
        compiledRegex: new RegExp(bareClassRegex, 'g'),
      },
    },
    gating: { ...DEFAULT_GATING, ...(overrides.gating ?? {}) },
  };
};
