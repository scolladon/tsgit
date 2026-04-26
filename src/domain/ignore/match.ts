import type { FilePath } from '../objects/object-id.js';
import type { IgnoreRuleset } from './parse-gitignore.js';

export type MatchResult = 'ignored' | 'unignored' | 'unset';

/**
 * Apply an ignore ruleset to a path. Last-matching rule wins (per Git semantics).
 *
 * `isDir` is required because `directoryOnly` rules (`build/`) only apply to
 * directories. The caller knows whether the path is a directory.
 */
export const matches = (rules: IgnoreRuleset, path: FilePath, isDir: boolean): MatchResult => {
  let result: MatchResult = 'unset';
  for (const rule of rules) {
    if (rule.directoryOnly && !isDir) continue;
    if (rule.compiled.test(path)) {
      result = rule.negated ? 'unignored' : 'ignored';
    }
  }
  return result;
};
