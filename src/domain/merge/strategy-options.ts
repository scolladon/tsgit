/**
 * git's `parse_merge_opt` (`merge-ort.c`) for the `-X` values ort reads. The
 * rename and side-favouring ones are honoured; the others git knows refuse
 * until tsgit runs them, and anything else refuses as git's `unknown strategy
 * option` does.
 */
import { unknownStrategyOption } from '../commands/error.js';
import { parseRenameScore } from '../diff/rename-score.js';
import { unsupportedOperation } from '../error.js';

/** The rename settings `-X` overrides; an absent field keeps the configured one. */
export interface OrtRenameOptions {
  readonly detect?: boolean;
  /** Similarity gate on the 0..MAX_SCORE scale; absent is git's default 50%. */
  readonly threshold?: number;
}

/** The side `-X ours` / `-X theirs` keeps for every overlapping hunk. */
export type OrtVariant = 'ours' | 'theirs';

export interface OrtStrategyOptions {
  readonly renames: OrtRenameOptions;
  readonly variant?: OrtVariant;
}

const VARIANTS: ReadonlySet<string> = new Set<OrtVariant>(['ours', 'theirs']);
const isVariant = (option: string): option is OrtVariant => VARIANTS.has(option);

const THRESHOLD_PREFIXES = ['find-renames=', 'rename-threshold='] as const;
const DIFF_ALGORITHM_PREFIX = 'diff-algorithm=';
const DIFF_ALGORITHMS: ReadonlySet<string> = new Set([
  'myers',
  'default',
  'minimal',
  'patience',
  'histogram',
]);
const UNSUPPORTED: ReadonlySet<string> = new Set([
  'subtree',
  'patience',
  'histogram',
  'ignore-space-change',
  'ignore-all-space',
  'ignore-space-at-eol',
  'ignore-cr-at-eol',
  'renormalize',
  'no-renormalize',
]);
const SUBTREE_PREFIX = 'subtree=';

const isUnsupported = (option: string): boolean => {
  if (UNSUPPORTED.has(option) || option.startsWith(SUBTREE_PREFIX)) return true;
  if (!option.startsWith(DIFF_ALGORITHM_PREFIX)) return false;
  return DIFF_ALGORITHMS.has(option.slice(DIFF_ALGORITHM_PREFIX.length).toLowerCase());
};

/** git's `rename_score`: 0 stands for the default, which an absent threshold already means. */
const withThreshold = (settings: OrtRenameOptions, score: number): OrtRenameOptions => {
  const { threshold: _dropped, ...rest } = settings;
  return score === 0 ? { ...rest, detect: true } : { ...rest, detect: true, threshold: score };
};

const thresholdText = (option: string): string | undefined => {
  const prefix = THRESHOLD_PREFIXES.find((candidate) => option.startsWith(candidate));
  return prefix === undefined ? undefined : option.slice(prefix.length);
};

const applyRenameOption = (settings: OrtRenameOptions, option: string): OrtRenameOptions => {
  if (option === 'no-renames') return { ...settings, detect: false };
  if (option === 'find-renames') return withThreshold(settings, 0);
  const text = thresholdText(option);
  if (text !== undefined) {
    const { score, rest } = parseRenameScore(text);
    if (rest === '') return withThreshold(settings, score);
  }
  if (isUnsupported(option)) throw unsupportedOperation('merge', `-X${option}`);
  throw unknownStrategyOption(option);
};

const applyOption = (settings: OrtStrategyOptions, option: string): OrtStrategyOptions => {
  if (isVariant(option)) return { ...settings, variant: option };
  return { ...settings, renames: applyRenameOption(settings.renames, option) };
};

export const parseOrtStrategyOptions = (options: ReadonlyArray<string>): OrtStrategyOptions =>
  options.reduce(applyOption, { renames: {} });
