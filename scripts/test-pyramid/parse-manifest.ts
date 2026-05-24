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

export interface PyramidManifest {
  readonly tiers: ReadonlyArray<TierDefinition>;
  readonly heuristics: {
    readonly overMockedIntegration: OverMockedHeuristic;
    readonly underAssertedUnit: UnderAssertedHeuristic;
  };
}

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

const compileRegex = (pattern: string, heuristicName: string): RegExp => {
  try {
    return new RegExp(pattern, 'g');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return fail(`heuristic regex invalid (${heuristicName}): ${message}`);
  }
};

const parseOverMocked = (
  raw: unknown,
  tierNames: ReadonlySet<TierName>,
): OverMockedHeuristic => {
  if (!isObject(raw)) {
    return fail('overMockedIntegration must be an object');
  }
  const { tier, regex, threshold } = raw;
  if (typeof tier !== 'string' || tier.length === 0) {
    return fail('overMockedIntegration tier must be a non-empty string');
  }
  if (!tierNames.has(tier)) {
    return fail(`overMockedIntegration references unknown tier "${tier}"`);
  }
  if (typeof regex !== 'string' || regex.length === 0) {
    return fail('overMockedIntegration regex must be a non-empty string');
  }
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
    return fail('overMockedIntegration threshold must be a number >= 0');
  }
  return {
    tier,
    regex,
    compiledRegex: compileRegex(regex, 'overMockedIntegration'),
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
  const { tier, minAssertionsPerTest } = raw;
  if (typeof tier !== 'string' || tier.length === 0) {
    return fail('underAssertedUnit tier must be a non-empty string');
  }
  if (!tierNames.has(tier)) {
    return fail(`underAssertedUnit references unknown tier "${tier}"`);
  }
  if (
    typeof minAssertionsPerTest !== 'number' ||
    !Number.isInteger(minAssertionsPerTest) ||
    minAssertionsPerTest < 1
  ) {
    return fail('underAssertedUnit minAssertionsPerTest must be an integer >= 1');
  }
  return { tier, minAssertionsPerTest };
};

export const parseManifest = (raw: string): PyramidManifest => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail('not valid JSON');
  }
  if (!isObject(json)) return fail('top-level value must be an object');

  const { tiers, heuristics } = json;

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

  const { overMockedIntegration, underAssertedUnit } = heuristics;
  if (overMockedIntegration === undefined) {
    return fail('heuristics.overMockedIntegration is required');
  }
  if (underAssertedUnit === undefined) {
    return fail('heuristics.underAssertedUnit is required');
  }

  const tierNames = new Set(parsedTiers.map((t) => t.name));
  return {
    tiers: parsedTiers,
    heuristics: {
      overMockedIntegration: parseOverMocked(overMockedIntegration, tierNames),
      underAssertedUnit: parseUnderAsserted(underAssertedUnit, tierNames),
    },
  };
};
