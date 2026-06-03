/**
 * `--match` / `--exclude` filtering of a candidate tag's short name. Reuses the
 * anchored `compileGlob` matcher (`*`/`?`/`**`, no character classes). With no
 * include patterns every name is included; an include must match for inclusion;
 * any matching exclude drops the name (exclusion wins).
 */
import { compileGlob, type GlobMatcher } from '../pathspec/index.js';

export interface NameFilter {
  matches(name: string): boolean;
}

const anchored = (pattern: string): GlobMatcher => compileGlob(pattern, { anchored: true });

export const buildNameFilter = (
  include: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>,
): NameFilter => {
  const includeMatchers = include.map(anchored);
  const excludeMatchers = exclude.map(anchored);
  return {
    matches(name: string): boolean {
      const included = includeMatchers.length === 0 || includeMatchers.some((m) => m.test(name));
      if (!included) return false;
      return !excludeMatchers.some((m) => m.test(name));
    },
  };
};

export const tagNameMatches = (
  name: string,
  include: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>,
): boolean => buildNameFilter(include, exclude).matches(name);
