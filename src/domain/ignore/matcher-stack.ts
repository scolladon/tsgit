import type { FilePath } from '../objects/object-id.js';
import { type MatchResult, matchesVerbose } from './match.js';
import type { IgnoreRuleset } from './parse-gitignore.js';

/**
 * One layer of ignore rules anchored at a directory inside the repo.
 *
 * `basedir === ''` is the repository root. A non-root `basedir` is a
 * POSIX path relative to the repo root (no trailing slash). Rules
 * inside a level treat paths as if `basedir/` were stripped — a
 * non-anchored `*.log` at basedir `sub` matches `sub/foo.log` (the
 * rule "sees" `foo.log`).
 *
 * `kind` distinguishes the three sources whose `basedir` is identical
 * (the empty string at the repo root): a global excludes file, the
 * repository's `info/exclude`, and a regular `.gitignore`. Defaults
 * to `'gitignore'` so existing callers don't have to migrate.
 */
export interface IgnoreLevel {
  readonly basedir: FilePath | '';
  readonly rules: IgnoreRuleset;
  readonly kind?: 'global' | 'info' | 'gitignore';
}

/**
 * Verbose stack-match result. `verdict` mirrors `matchInStack`'s return.
 * `level` and `ruleIndex` identify which rule (in which level) produced
 * the verdict — present iff `verdict !== 'unset'`.
 */
export interface VerboseMatch {
  readonly verdict: MatchResult;
  readonly level?: IgnoreLevel;
  readonly ruleIndex?: number;
}

const relativize = (path: FilePath, basedir: FilePath | ''): FilePath | undefined => {
  if (basedir === '') return path;
  const prefix = `${basedir}/`;
  if (!path.startsWith(prefix)) return undefined;
  return path.slice(prefix.length) as FilePath;
};

/**
 * Last-matching-rule-wins evaluation across a stack of ignore levels.
 *
 * Levels in the stack are evaluated in order (caller controls the order
 * — typically global → info/exclude → repo root → nested-deeper-last).
 * For each level, the rule is consulted only if the path falls under
 * the level's `basedir`; the matched path is relativized to the basedir
 * before consultation. The overall result is the last non-`unset`
 * result observed.
 */
export const matchInStack = (
  stack: ReadonlyArray<IgnoreLevel>,
  path: FilePath,
  isDir: boolean,
): MatchResult => matchInStackVerbose(stack, path, isDir).verdict;

/**
 * Verbose variant — same evaluation as `matchInStack`, but also reports
 * the matching level and rule index. Used by `isIgnored` to surface the
 * "which rule decided this?" provenance.
 */
export const matchInStackVerbose = (
  stack: ReadonlyArray<IgnoreLevel>,
  path: FilePath,
  isDir: boolean,
): VerboseMatch => {
  let result: VerboseMatch = { verdict: 'unset' };
  for (const level of stack) {
    const relative = relativize(path, level.basedir);
    if (relative === undefined) continue;
    const inner = matchesVerbose(level.rules, relative, isDir);
    if (inner.ruleIndex !== undefined) {
      result = { verdict: inner.verdict, level, ruleIndex: inner.ruleIndex };
    }
  }
  return result;
};
