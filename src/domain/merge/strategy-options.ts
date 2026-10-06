/**
 * git's `parse_merge_opt` (`merge-ort.c`) for the `-X` values ort reads. The
 * rename and side-favouring ones are honoured; the others git knows refuse
 * until tsgit runs them, and anything else refuses as git's `unknown strategy
 * option` does.
 */
import { unknownStrategyOption } from '../commands/error.js';
import { parseRenameScore } from '../diff/rename-score.js';
import { type LineKey, NONE_KEY, type WhitespaceMode } from '../diff/whitespace.js';
import type { SearchMode } from '../diff/xdiff/xdl-prepare.js';
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
  /** The whitespace the content merge's line diffs ignore (`-X ignore-*`). */
  readonly lineKey?: LineKey;
  /** `minimal` when `-X diff-algorithm=minimal` asks for xdiff's exhaustive search. */
  readonly diffSearch?: SearchMode;
}

/** xdiff's `xdl_recmatch` tests the flags all → change → at-eol, so the strongest set one wins. */
const WHITESPACE_STRENGTH: ReadonlyArray<WhitespaceMode> = ['none', 'at-eol', 'change', 'all'];
const WHITESPACE_OPTIONS: ReadonlyMap<string, WhitespaceMode> = new Map([
  ['ignore-space-at-eol', 'at-eol'],
  ['ignore-space-change', 'change'],
  ['ignore-all-space', 'all'],
]);
const IGNORE_CR_AT_EOL = 'ignore-cr-at-eol';

const strongerMode = (a: WhitespaceMode, b: WhitespaceMode): WhitespaceMode =>
  WHITESPACE_STRENGTH.indexOf(a) >= WHITESPACE_STRENGTH.indexOf(b) ? a : b;

const withWhitespace = (key: LineKey, option: string): LineKey | undefined => {
  if (option === IGNORE_CR_AT_EOL) return { ...key, ignoreCrAtEol: true };
  const mode = WHITESPACE_OPTIONS.get(option);
  return mode === undefined ? undefined : { ...key, mode: strongerMode(key.mode, mode) };
};

const VARIANTS: ReadonlySet<string> = new Set<OrtVariant>(['ours', 'theirs']);
const isVariant = (option: string): option is OrtVariant => VARIANTS.has(option);

const THRESHOLD_PREFIXES = ['find-renames=', 'rename-threshold='] as const;
const DIFF_ALGORITHM_PREFIX = 'diff-algorithm=';
/** xdiff's algorithm bits, cleared and reset by every algorithm option, so the last one named wins. */
const SEARCH_BY_ALGORITHM: ReadonlyMap<string, SearchMode | undefined> = new Map([
  ['myers', undefined],
  ['default', undefined],
  ['minimal', 'minimal'],
  ['patience', undefined],
  ['histogram', undefined],
]);
const UNIMPLEMENTED_ALGORITHMS: ReadonlySet<string> = new Set(['patience', 'histogram']);
const UNSUPPORTED: ReadonlySet<string> = new Set(['subtree']);
const RENORMALIZE = 'renormalize';
const NO_RENORMALIZE = 'no-renormalize';
const SUBTREE_PREFIX = 'subtree=';

const isUnsupported = (option: string): boolean =>
  UNSUPPORTED.has(option) || option.startsWith(SUBTREE_PREFIX);

const algorithmNamed = (option: string): string | undefined => {
  if (UNIMPLEMENTED_ALGORITHMS.has(option)) return option;
  if (!option.startsWith(DIFF_ALGORITHM_PREFIX)) return undefined;
  const name = option.slice(DIFF_ALGORITHM_PREFIX.length).toLowerCase();
  return SEARCH_BY_ALGORITHM.has(name) ? name : undefined;
};

/**
 * The settings so far, plus the last-wins choices tsgit cannot run yet: the
 * option that last chose such an algorithm, and a standing renormalization.
 */
interface Parsed {
  readonly settings: OrtStrategyOptions;
  readonly unimplemented?: string;
  readonly renormalize?: boolean;
}

const withAlgorithm = (parsed: Parsed, option: string, name: string): Parsed => {
  const { diffSearch: _replaced, ...rest } = parsed.settings;
  const search = SEARCH_BY_ALGORITHM.get(name);
  const { unimplemented: _dropped, ...kept } = parsed;
  const next = { ...kept, settings: search === undefined ? rest : { ...rest, diffSearch: search } };
  return UNIMPLEMENTED_ALGORITHMS.has(name) ? { ...next, unimplemented: option } : next;
};

/** `-X renormalize` runs every merged blob through attribute conversion; tsgit has no eol conversion. */
const refusalOf = ({ unimplemented, renormalize }: Parsed): string | undefined =>
  unimplemented ?? (renormalize === true ? RENORMALIZE : undefined);

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

const applySetting = (settings: OrtStrategyOptions, option: string): OrtStrategyOptions => {
  if (isVariant(option)) return { ...settings, variant: option };
  const lineKey = withWhitespace(settings.lineKey ?? NONE_KEY, option);
  if (lineKey !== undefined) return { ...settings, lineKey };
  return { ...settings, renames: applyRenameOption(settings.renames, option) };
};

const applyOption = (parsed: Parsed, option: string): Parsed => {
  const algorithm = algorithmNamed(option);
  if (algorithm !== undefined) return withAlgorithm(parsed, option, algorithm);
  if (option === RENORMALIZE || option === NO_RENORMALIZE) {
    return { ...parsed, renormalize: option === RENORMALIZE };
  }
  return { ...parsed, settings: applySetting(parsed.settings, option) };
};

export const parseOrtStrategyOptions = (options: ReadonlyArray<string>): OrtStrategyOptions => {
  const parsed = options.reduce(applyOption, { settings: { renames: {} } });
  const refusal = refusalOf(parsed);
  if (refusal !== undefined) throw unsupportedOperation('merge', `-X${refusal}`);
  return parsed.settings;
};
