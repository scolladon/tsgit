import type { FilePath } from '../objects/object-id.js';
import { type MatchResult, matches } from './match.js';
import type { IgnoreRuleset } from './parse-gitignore.js';

/**
 * One layer of ignore rules anchored at a directory inside the repo.
 *
 * `basedir === ''` is the repository root. A non-root `basedir` is a
 * POSIX path relative to the repo root (no trailing slash). Rules
 * inside a level treat paths as if `basedir/` were stripped — a
 * non-anchored `*.log` at basedir `sub` matches `sub/foo.log` (the
 * rule "sees" `foo.log`).
 */
export interface IgnoreLevel {
  readonly basedir: FilePath | '';
  readonly rules: IgnoreRuleset;
}

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
): MatchResult => {
  let result: MatchResult = 'unset';
  for (const level of stack) {
    const relative = relativize(path, level.basedir);
    if (relative === undefined) continue;
    const r = matches(level.rules, relative, isDir);
    if (r !== 'unset') result = r;
  }
  return result;
};

const relativize = (path: FilePath, basedir: FilePath | ''): FilePath | undefined => {
  if (basedir === '') return path;
  const prefix = `${basedir}/`;
  if (!path.startsWith(prefix)) return undefined;
  return path.slice(prefix.length) as FilePath;
};
