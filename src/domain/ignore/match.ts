import type { FilePath } from '../objects/object-id.js';
import type { IgnoreRule, IgnoreRuleset } from './parse-gitignore.js';

export type MatchResult = 'ignored' | 'unignored' | 'unset';

/**
 * Verbose match result. `ruleIndex` is the index of the LAST matching rule
 * inside the ruleset; `verdict` reflects whether that rule was negated.
 * When no rule matched, `verdict === 'unset'` and `ruleIndex === undefined`.
 */
export interface VerboseLevelMatch {
  readonly verdict: MatchResult;
  readonly ruleIndex?: number;
}

const lastMatch = (
  rules: IgnoreRuleset,
  path: FilePath,
  isDir: boolean,
): { rule: IgnoreRule; index: number } | undefined => {
  let found: { rule: IgnoreRule; index: number } | undefined;
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i] as IgnoreRule;
    if (rule.directoryOnly && !isDir) continue;
    if (rule.compiled.test(path)) {
      found = { rule, index: i };
    }
  }
  return found;
};

/**
 * Apply an ignore ruleset to a path. Last-matching rule wins (per Git semantics).
 *
 * `isDir` is required because `directoryOnly` rules (`build/`) only apply to
 * directories. The caller knows whether the path is a directory.
 */
export const matches = (rules: IgnoreRuleset, path: FilePath, isDir: boolean): MatchResult => {
  const found = lastMatch(rules, path, isDir);
  if (found === undefined) return 'unset';
  return found.rule.negated ? 'unignored' : 'ignored';
};

/**
 * Verbose variant — same last-matching-rule-wins evaluation as `matches`, but
 * also reports the index of the matching rule so callers (e.g., `isIgnored`)
 * can surface the rule's source line and pattern. Returns `verdict: 'unset'`
 * with `ruleIndex === undefined` when nothing matched.
 */
export const matchesVerbose = (
  rules: IgnoreRuleset,
  path: FilePath,
  isDir: boolean,
): VerboseLevelMatch => {
  const found = lastMatch(rules, path, isDir);
  if (found === undefined) return { verdict: 'unset' };
  return {
    verdict: found.rule.negated ? 'unignored' : 'ignored',
    ruleIndex: found.index,
  };
};
