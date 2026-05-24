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
  DirectoryClass,
  GatingConfig,
  PyramidManifest,
  TierDefinition,
} from '../../../test-pyramid/parse-manifest.js';

interface GwtTitleOverrides {
  readonly describeGiven?: string;
  readonly describeWhen?: string;
  readonly describeCombined?: string;
  readonly itThen?: string;
  readonly legacyItGwt?: string;
}

interface IntegrationProofOverrides {
  readonly buckets?: ReadonlyArray<string>;
  readonly surfaceRegex?: string;
  readonly uniqueMinLength?: number;
  readonly uniqueMaxLength?: number;
  readonly directoryRules?: ReadonlyMap<string, ReadonlyArray<DirectoryClass>>;
}

interface ManifestOverrides {
  readonly tiers?: ReadonlyArray<TierDefinition>;
  readonly overMockedRegex?: string;
  readonly underAssertedMin?: number;
  readonly gwtTitle?: GwtTitleOverrides;
  readonly aaaRequired?: ReadonlyArray<AaaMarker>;
  readonly sutBanned?: ReadonlyArray<string>;
  readonly bareClassRegex?: string;
  readonly integrationProof?: IntegrationProofOverrides;
  readonly gating?: Partial<GatingConfig>;
  readonly excludePaths?: ReadonlyArray<string>;
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
const DEFAULT_GWT_DESCRIBE_GIVEN = '^Given .+$';
const DEFAULT_GWT_DESCRIBE_WHEN = '^When .+$';
const DEFAULT_GWT_DESCRIBE_COMBINED = '^Given .+?, When .+$';
const DEFAULT_GWT_IT_THEN = '^Then .+$';
const DEFAULT_GWT_LEGACY_IT = '^Given .+?, When .+?, Then .+$';
const DEFAULT_BARE_CLASS_REGEX = '\\.toThrow(?:Error)?\\s*\\(\\s*([A-Z]\\w*)\\s*\\)';

const DEFAULT_INTEGRATION_BUCKETS: ReadonlyArray<string> = [
  'real-fs',
  'real-http',
  'real-process',
  'cross-tool-interop',
  'platform-only',
  'multi-adapter-parity',
  'coverage-gap',
];

const DEFAULT_SURFACE_REGEX_SOURCE = '^[a-z][a-zA-Z0-9.-]{1,40}$';

const DEFAULT_DIRECTORY_RULES: ReadonlyMap<string, ReadonlyArray<DirectoryClass>> = new Map<
  string,
  ReadonlyArray<DirectoryClass>
>([
  ['real-http', ['network/']],
  ['real-fs', ['root', 'posix-only/', 'win-only/']],
  ['real-process', ['posix-only/', 'win-only/']],
  ['platform-only', ['posix-only/', 'win-only/']],
  ['cross-tool-interop', ['root']],
  ['multi-adapter-parity', ['root']],
  ['coverage-gap', ['root']],
]);

const DEFAULT_GATING: GatingConfig = {
  overMockedIntegration: false,
  underAssertedUnit: false,
  gwtTitle: false,
  aaaBody: false,
  sutNaming: false,
  bareClassToThrow: false,
  emptyAaaSection: false,
  integrationProof: false,
};

export const makeManifest = (overrides: ManifestOverrides = {}): PyramidManifest => {
  const overMockedRegex = overrides.overMockedRegex ?? DEFAULT_OVER_MOCKED_REGEX;
  const gwt = overrides.gwtTitle ?? {};
  const describeGiven = gwt.describeGiven ?? DEFAULT_GWT_DESCRIBE_GIVEN;
  const describeWhen = gwt.describeWhen ?? DEFAULT_GWT_DESCRIBE_WHEN;
  const describeCombined = gwt.describeCombined ?? DEFAULT_GWT_DESCRIBE_COMBINED;
  const itThen = gwt.itThen ?? DEFAULT_GWT_IT_THEN;
  const legacyItGwt = gwt.legacyItGwt ?? DEFAULT_GWT_LEGACY_IT;
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
        describeGiven,
        describeWhen,
        describeCombined,
        itThen,
        legacyItGwt,
        describeGivenRe: new RegExp(describeGiven),
        describeWhenRe: new RegExp(describeWhen),
        describeCombinedRe: new RegExp(describeCombined),
        itThenRe: new RegExp(itThen),
        legacyItGwtRe: new RegExp(legacyItGwt),
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
      emptyAaaSection: {
        tier: 'unit',
      },
      integrationProof: ((): PyramidManifest['heuristics']['integrationProof'] => {
        const ip = overrides.integrationProof ?? {};
        const buckets = ip.buckets ?? DEFAULT_INTEGRATION_BUCKETS;
        const surfaceRegexSource = ip.surfaceRegex ?? DEFAULT_SURFACE_REGEX_SOURCE;
        return {
          tier: 'integration',
          buckets,
          surfaceRegex: new RegExp(surfaceRegexSource),
          surfaceRegexSource,
          uniqueMinLength: ip.uniqueMinLength ?? 12,
          uniqueMaxLength: ip.uniqueMaxLength ?? 200,
          directoryRules: ip.directoryRules ?? DEFAULT_DIRECTORY_RULES,
        };
      })(),
    },
    gating: { ...DEFAULT_GATING, ...(overrides.gating ?? {}) },
    excludePaths: overrides.excludePaths ?? [],
  };
};
