/**
 * Pyramid-audit manifest parser.
 *
 * Validates `test-pyramid-budgets.json` and returns a typed handle. Hand-rolled
 * validator — no Zod — matching the convention from `scripts/mutation-budgets.ts`.
 * Failures throw with `manifest invalid: <reason>`; callers translate that into
 * the script's exit-1 path.
 */

export type TierName = string;

export interface TierDefinition {
  readonly name: TierName;
  readonly glob: string;
  readonly target: number;
  readonly warnBelow: number;
  readonly warnAbove: number | null;
}

export interface OverMockedHeuristic {
  readonly tier: TierName;
  readonly regex: string;
  readonly compiledRegex: RegExp;
  readonly threshold: number;
}

export interface UnderAssertedHeuristic {
  readonly tier: TierName;
  readonly minAssertionsPerTest: number;
}

export type AaaMarker = 'Arrange' | 'Act' | 'Assert';

export interface GwtTitleHeuristic {
  readonly tier: TierName;
  // Raw patterns kept for diagnostics; compiled forms are the runtime path.
  readonly describeGiven: string;
  readonly describeWhen: string;
  readonly describeCombined: string;
  readonly itThen: string;
  readonly legacyItGwt: string;
  // Compiled stateless RegExps (no `g` flag per ADR-113).
  readonly describeGivenRe: RegExp;
  readonly describeWhenRe: RegExp;
  readonly describeCombinedRe: RegExp;
  readonly itThenRe: RegExp;
  readonly legacyItGwtRe: RegExp;
}

export interface AaaBodyHeuristic {
  readonly tier: TierName;
  readonly required: ReadonlyArray<AaaMarker>;
}

export interface SutNamingHeuristic {
  readonly tier: TierName;
  readonly banned: ReadonlyArray<string>;
}

export interface BareClassThrowHeuristic {
  readonly tier: TierName;
  readonly regex: string;
  readonly compiledRegex: RegExp;
}

export interface EmptyAaaSectionHeuristic {
  readonly tier: TierName;
}

export const DIRECTORY_CLASSES = ['root', 'network/', 'posix-only/', 'win-only/'] as const;
export type DirectoryClass = (typeof DIRECTORY_CLASSES)[number];

export interface IntegrationProofHeuristic {
  readonly tier: TierName;
  readonly buckets: ReadonlyArray<string>;
  readonly surfaceRegex: RegExp;
  readonly surfaceRegexSource: string;
  readonly uniqueMinLength: number;
  readonly uniqueMaxLength: number;
  readonly directoryRules: ReadonlyMap<string, ReadonlyArray<DirectoryClass>>;
}

export const GATING_KEYS = [
  'overMockedIntegration',
  'underAssertedUnit',
  'gwtTitle',
  'aaaBody',
  'sutNaming',
  'bareClassToThrow',
  'emptyAaaSection',
  'integrationProof',
] as const;
export type GatingKey = (typeof GATING_KEYS)[number];
export type GatingConfig = Readonly<Record<GatingKey, boolean>>;

export interface PyramidManifest {
  readonly tiers: ReadonlyArray<TierDefinition>;
  readonly heuristics: {
    readonly overMockedIntegration: OverMockedHeuristic;
    readonly underAssertedUnit: UnderAssertedHeuristic;
    readonly gwtTitle: GwtTitleHeuristic;
    readonly aaaBody: AaaBodyHeuristic;
    readonly sutNaming: SutNamingHeuristic;
    readonly bareClassToThrow: BareClassThrowHeuristic;
    readonly emptyAaaSection: EmptyAaaSectionHeuristic;
    readonly integrationProof: IntegrationProofHeuristic;
  };
  readonly gating: GatingConfig;
  readonly excludePaths: ReadonlyArray<string>;
}

const AAA_MARKERS: ReadonlySet<AaaMarker> = new Set<AaaMarker>(['Arrange', 'Act', 'Assert']);

const fail = (reason: string): never => {
  throw new Error(`manifest invalid: ${reason}`);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

const parseTier = (raw: unknown, index: number): TierDefinition => {
  if (!isObject(raw)) return fail(`tier #${index} must be an object`);

  const { name, glob, target, warnBelow, warnAbove } = raw;

  if (typeof name !== 'string' || name.length === 0) {
    return fail(`tier #${index} name must be a non-empty string`);
  }
  if (typeof glob !== 'string' || glob.length === 0) {
    return fail(`tier "${name}" glob must be a non-empty string`);
  }
  if (!isPercent(target)) {
    return fail(`tier "${name}" target must be a number 0..100`);
  }
  if (!isPercent(warnBelow)) {
    return fail(`tier "${name}" warnBelow must be a number 0..100`);
  }
  if (warnBelow > target) {
    return fail(`tier "${name}" warnBelow must be <= target`);
  }

  let warnAboveValue: number | null;
  if (warnAbove === null || warnAbove === undefined) {
    warnAboveValue = null;
  } else if (isPercent(warnAbove)) {
    if (warnAbove < target) {
      return fail(`tier "${name}" warnAbove must be >= target`);
    }
    warnAboveValue = warnAbove;
  } else {
    return fail(`tier "${name}" warnAbove must be a number 0..100 or null`);
  }

  return { name, glob, target, warnBelow, warnAbove: warnAboveValue };
};

const compileRegex = (
  pattern: string,
  heuristicName: string,
  flags: string,
): RegExp => {
  try {
    return new RegExp(pattern, flags);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return fail(`heuristic regex invalid (${heuristicName}): ${message}`);
  }
};

const requireTier = (
  raw: unknown,
  field: string,
  tierNames: ReadonlySet<TierName>,
): TierName => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail(`${field} tier must be a non-empty string`);
  }
  if (!tierNames.has(raw)) {
    return fail(`${field} references unknown tier "${raw}"`);
  }
  return raw;
};

const requireRegexPattern = (raw: unknown, field: string): string => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail(`${field} regex must be a non-empty string`);
  }
  return raw;
};

const parseOverMocked = (
  raw: unknown,
  tierNames: ReadonlySet<TierName>,
): OverMockedHeuristic => {
  if (!isObject(raw)) {
    return fail('overMockedIntegration must be an object');
  }
  const tier = requireTier(raw.tier, 'overMockedIntegration', tierNames);
  const regex = requireRegexPattern(raw.regex, 'overMockedIntegration');
  const { threshold } = raw;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
    return fail('overMockedIntegration threshold must be a number >= 0');
  }
  return {
    tier,
    regex,
    compiledRegex: compileRegex(regex, 'overMockedIntegration', 'g'),
    threshold,
  };
};

const parseUnderAsserted = (
  raw: unknown,
  tierNames: ReadonlySet<TierName>,
): UnderAssertedHeuristic => {
  if (!isObject(raw)) {
    return fail('underAssertedUnit must be an object');
  }
  const tier = requireTier(raw.tier, 'underAssertedUnit', tierNames);
  const { minAssertionsPerTest } = raw;
  if (
    typeof minAssertionsPerTest !== 'number' ||
    !Number.isInteger(minAssertionsPerTest) ||
    minAssertionsPerTest < 1
  ) {
    return fail('underAssertedUnit minAssertionsPerTest must be an integer >= 1');
  }
  return { tier, minAssertionsPerTest };
};

const parseGwtTitle = (
  raw: unknown,
  tierNames: ReadonlySet<TierName>,
): GwtTitleHeuristic => {
  if (!isObject(raw)) {
    return fail('gwtTitle must be an object');
  }
  const tier = requireTier(raw.tier, 'gwtTitle', tierNames);
  const describeGiven = requireRegexPattern(raw.describeGiven, 'gwtTitle.describeGiven');
  const describeWhen = requireRegexPattern(raw.describeWhen, 'gwtTitle.describeWhen');
  const describeCombined = requireRegexPattern(
    raw.describeCombined,
    'gwtTitle.describeCombined',
  );
  const itThen = requireRegexPattern(raw.itThen, 'gwtTitle.itThen');
  const legacyItGwt = requireRegexPattern(raw.legacyItGwt, 'gwtTitle.legacyItGwt');
  return {
    tier,
    describeGiven,
    describeWhen,
    describeCombined,
    itThen,
    legacyItGwt,
    describeGivenRe: compileRegex(describeGiven, 'gwtTitle.describeGiven', ''),
    describeWhenRe: compileRegex(describeWhen, 'gwtTitle.describeWhen', ''),
    describeCombinedRe: compileRegex(describeCombined, 'gwtTitle.describeCombined', ''),
    itThenRe: compileRegex(itThen, 'gwtTitle.itThen', ''),
    legacyItGwtRe: compileRegex(legacyItGwt, 'gwtTitle.legacyItGwt', ''),
  };
};

const parseAaaBody = (
  raw: unknown,
  tierNames: ReadonlySet<TierName>,
): AaaBodyHeuristic => {
  if (!isObject(raw)) {
    return fail('aaaBody must be an object');
  }
  const tier = requireTier(raw.tier, 'aaaBody', tierNames);
  const { required } = raw;
  if (!Array.isArray(required) || required.length === 0) {
    return fail('aaaBody required must be a non-empty array');
  }
  const seen = new Set<AaaMarker>();
  const markers: AaaMarker[] = [];
  for (const entry of required) {
    if (typeof entry !== 'string' || !AAA_MARKERS.has(entry as AaaMarker)) {
      return fail(`aaaBody required entry "${String(entry)}" must be Arrange|Act|Assert`);
    }
    const marker = entry as AaaMarker;
    if (seen.has(marker)) {
      return fail(`aaaBody required has duplicate "${marker}"`);
    }
    seen.add(marker);
    markers.push(marker);
  }
  return { tier, required: markers };
};

const parseSutNaming = (
  raw: unknown,
  tierNames: ReadonlySet<TierName>,
): SutNamingHeuristic => {
  if (!isObject(raw)) {
    return fail('sutNaming must be an object');
  }
  const tier = requireTier(raw.tier, 'sutNaming', tierNames);
  const { banned } = raw;
  if (!Array.isArray(banned) || banned.length === 0) {
    return fail('sutNaming banned must be a non-empty array');
  }
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const entry of banned) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return fail('sutNaming banned entry must be a non-empty string');
    }
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entry)) {
      return fail(`sutNaming banned entry "${entry}" must be a valid identifier`);
    }
    if (seen.has(entry)) {
      return fail(`sutNaming banned has duplicate "${entry}"`);
    }
    seen.add(entry);
    aliases.push(entry);
  }
  return { tier, banned: aliases };
};

const parseBareClassThrow = (
  raw: unknown,
  tierNames: ReadonlySet<TierName>,
): BareClassThrowHeuristic => {
  if (!isObject(raw)) {
    return fail('bareClassToThrow must be an object');
  }
  const tier = requireTier(raw.tier, 'bareClassToThrow', tierNames);
  const regex = requireRegexPattern(raw.regex, 'bareClassToThrow');
  return { tier, regex, compiledRegex: compileRegex(regex, 'bareClassToThrow', 'g') };
};

const parseEmptyAaaSection = (
  raw: unknown,
  tierNames: ReadonlySet<TierName>,
): EmptyAaaSectionHeuristic => {
  if (!isObject(raw)) {
    return fail('emptyAaaSection must be an object');
  }
  const tier = requireTier(raw.tier, 'emptyAaaSection', tierNames);
  return { tier };
};

const DIRECTORY_CLASS_SET: ReadonlySet<string> = new Set<string>(DIRECTORY_CLASSES);

const requirePositiveInt = (raw: unknown, field: string): number => {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    return fail(`${field} must be a positive integer`);
  }
  return raw;
};

const parseBuckets = (raw: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail('integrationProof buckets must be a non-empty array');
  }
  const seen = new Set<string>();
  const buckets: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return fail('integrationProof bucket must be a non-empty string');
    }
    if (seen.has(entry)) {
      return fail(`integrationProof has duplicate bucket "${entry}"`);
    }
    seen.add(entry);
    buckets.push(entry);
  }
  return buckets;
};

const parseDirectoryRules = (
  raw: unknown,
  buckets: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<DirectoryClass>> => {
  if (!isObject(raw)) {
    return fail('integrationProof directoryRules must be an object');
  }
  const bucketSet = new Set(buckets);
  const keys = Object.keys(raw);
  if (keys.length !== buckets.length || keys.some((k) => !bucketSet.has(k))) {
    return fail('integrationProof directoryRules keys must equal buckets');
  }
  const map = new Map<string, ReadonlyArray<DirectoryClass>>();
  for (const bucket of buckets) {
    const entry = raw[bucket];
    if (!Array.isArray(entry) || entry.length === 0) {
      return fail(`integrationProof directoryRules entry must be a non-empty array (${bucket})`);
    }
    const classes: DirectoryClass[] = [];
    for (const value of entry) {
      if (typeof value !== 'string' || !DIRECTORY_CLASS_SET.has(value)) {
        return fail(
          `integrationProof directoryRules has unknown directory class "${String(value)}" for bucket "${bucket}"`,
        );
      }
      classes.push(value as DirectoryClass);
    }
    map.set(bucket, classes);
  }
  return map;
};

const parseIntegrationProof = (
  raw: unknown,
  tierNames: ReadonlySet<TierName>,
): IntegrationProofHeuristic => {
  if (!isObject(raw)) {
    return fail('integrationProof must be an object');
  }
  const tier = requireTier(raw.tier, 'integrationProof', tierNames);
  const buckets = parseBuckets(raw.buckets);
  const surfaceRegexSource = requireRegexPattern(raw.surfaceRegex, 'integrationProof.surfaceRegex');
  const surfaceRegex = compileRegex(surfaceRegexSource, 'integrationProof.surfaceRegex', '');
  const uniqueMinLength = requirePositiveInt(raw.uniqueMinLength, 'integrationProof.uniqueMinLength');
  const uniqueMaxLength = requirePositiveInt(raw.uniqueMaxLength, 'integrationProof.uniqueMaxLength');
  if (uniqueMinLength >= uniqueMaxLength) {
    return fail('integrationProof uniqueMinLength must be < uniqueMaxLength');
  }
  const directoryRules = parseDirectoryRules(raw.directoryRules, buckets);
  return {
    tier,
    buckets,
    surfaceRegex,
    surfaceRegexSource,
    uniqueMinLength,
    uniqueMaxLength,
    directoryRules,
  };
};

const DEFAULT_GATING: GatingConfig = Object.freeze<GatingConfig>({
  overMockedIntegration: false,
  underAssertedUnit: false,
  gwtTitle: false,
  aaaBody: false,
  sutNaming: false,
  bareClassToThrow: false,
  emptyAaaSection: false,
  integrationProof: false,
});

// `excludePaths` is reserved for the audit's own self-test fixtures — files
// that intentionally embed anti-patterns to exercise the detectors. Restrict
// patterns to the `tooling/test/` subtree so a stray entry can't silence
// real product tests. If a future use-case needs broader scope, weigh it in
// an ADR before relaxing.
const EXCLUDE_PREFIX = 'tooling/test/';

const parseExcludePaths = (raw: unknown): ReadonlyArray<string> => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return fail('excludePaths must be an array');
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return fail('excludePaths entry must be a non-empty string');
    }
    if (!entry.startsWith(EXCLUDE_PREFIX)) {
      return fail(
        `excludePaths entry "${entry}" must start with "${EXCLUDE_PREFIX}" (audit self-tests only)`,
      );
    }
    out.push(entry);
  }
  return out;
};

const isGatingKey = (key: string): key is GatingKey =>
  (GATING_KEYS as ReadonlyArray<string>).includes(key);

const parseGating = (raw: unknown): GatingConfig => {
  if (raw === undefined) return DEFAULT_GATING;
  if (!isObject(raw)) {
    return fail('gating must be an object');
  }
  const out: Record<GatingKey, boolean> = { ...DEFAULT_GATING };
  for (const [key, value] of Object.entries(raw)) {
    if (!isGatingKey(key)) {
      return fail(`gating references unknown heuristic "${key}"`);
    }
    if (typeof value !== 'boolean') {
      return fail(`gating "${key}" must be a boolean`);
    }
    out[key] = value;
  }
  return out;
};

export const parseManifest = (raw: string): PyramidManifest => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail('not valid JSON');
  }
  if (!isObject(json)) return fail('top-level value must be an object');

  const { tiers, heuristics, gating, excludePaths } = json;

  if (!Array.isArray(tiers)) return fail('tiers field is required and must be an array');
  if (tiers.length === 0) return fail('tiers must contain at least one entry');

  const parsedTiers = tiers.map(parseTier);

  const seen = new Set<TierName>();
  for (const tier of parsedTiers) {
    if (seen.has(tier.name)) {
      return fail(`duplicate tier name "${tier.name}"`);
    }
    seen.add(tier.name);
  }

  if (!isObject(heuristics)) return fail('heuristics block is required');

  const requiredHeuristicKeys = [
    'overMockedIntegration',
    'underAssertedUnit',
    'gwtTitle',
    'aaaBody',
    'sutNaming',
    'bareClassToThrow',
    'emptyAaaSection',
    'integrationProof',
  ] as const;
  for (const key of requiredHeuristicKeys) {
    if (heuristics[key] === undefined) {
      return fail(`heuristics.${key} is required`);
    }
  }

  const tierNames = new Set(parsedTiers.map((t) => t.name));
  return {
    tiers: parsedTiers,
    heuristics: {
      overMockedIntegration: parseOverMocked(heuristics.overMockedIntegration, tierNames),
      underAssertedUnit: parseUnderAsserted(heuristics.underAssertedUnit, tierNames),
      gwtTitle: parseGwtTitle(heuristics.gwtTitle, tierNames),
      aaaBody: parseAaaBody(heuristics.aaaBody, tierNames),
      sutNaming: parseSutNaming(heuristics.sutNaming, tierNames),
      bareClassToThrow: parseBareClassThrow(heuristics.bareClassToThrow, tierNames),
      emptyAaaSection: parseEmptyAaaSection(heuristics.emptyAaaSection, tierNames),
      integrationProof: parseIntegrationProof(heuristics.integrationProof, tierNames),
    },
    gating: parseGating(gating),
    excludePaths: parseExcludePaths(excludePaths),
  };
};
