/**
 * Pure resolver for `describe`'s options. Validates at the command boundary
 * (negative/non-integer `candidates`, and `dirty`/`broken` against an explicit
 * commit-ish) and normalises into a `ResolvedDescribePlan` the command consumes.
 * Every field is a data/behavior selector — none drive output cosmetics.
 */
import { invalidOption } from '../../../domain/commands/error.js';
import type { DescribeOptions } from '../describe.js';

const DEFAULT_CANDIDATES = 10;

export interface ResolvedDescribePlan {
  readonly tags: boolean;
  readonly all: boolean;
  readonly maxCandidates: number;
  readonly always: boolean;
  readonly firstParent: boolean;
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
  readonly dirty: boolean;
  readonly broken: boolean;
}

/** The only selectors `--contains` (a `name-rev` delegation) reads — no ancestor-walk fields. */
export interface ContainsPlan {
  readonly all: boolean;
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
  readonly always: boolean;
}

// In `contains` mode `describe` is `name-rev`; the ancestor-walk selectors have
// no meaning there, so supplying one is refused (an illegal combination at the
// library boundary — a deliberate divergence from git's silent ignore).
const CONTAINS_INCOMPATIBLE = [
  'candidates',
  'exactMatch',
  'firstParent',
  'dirty',
  'broken',
] as const satisfies ReadonlyArray<keyof DescribeOptions>;

const toPatterns = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
};

const resolveMaxCandidates = (opts: DescribeOptions): number => {
  if (
    opts.candidates !== undefined &&
    (!Number.isInteger(opts.candidates) || opts.candidates < 0)
  ) {
    throw invalidOption('candidates', `expected a non-negative integer, got ${opts.candidates}`);
  }
  if (opts.exactMatch === true) return 0;
  return opts.candidates ?? DEFAULT_CANDIDATES;
};

export const parseContainsOptions = (opts: DescribeOptions): ContainsPlan => {
  for (const key of CONTAINS_INCOMPATIBLE) {
    if (opts[key] !== undefined) {
      throw invalidOption(key, `option ${key} cannot be combined with contains`);
    }
  }
  return {
    all: opts.all === true,
    include: toPatterns(opts.match),
    exclude: toPatterns(opts.exclude),
    always: opts.always === true,
  };
};

export const parseDescribeOptions = (
  opts: DescribeOptions,
  hasExplicitInput: boolean,
): ResolvedDescribePlan => {
  const dirty = opts.dirty === true;
  const broken = opts.broken === true;
  if ((dirty || broken) && hasExplicitInput) {
    throw invalidOption('dirty', 'option dirty and commit-ishes cannot be used together');
  }
  return {
    tags: opts.tags === true,
    all: opts.all === true,
    maxCandidates: resolveMaxCandidates(opts),
    always: opts.always === true,
    firstParent: opts.firstParent === true,
    include: toPatterns(opts.match),
    exclude: toPatterns(opts.exclude),
    dirty,
    broken,
  };
};
