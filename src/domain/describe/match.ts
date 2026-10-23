/**
 * `--match` / `--exclude` filtering of a candidate tag's short name with git's
 * wildmatch dialect (no pathname mode): `*` and `?` cross `/`, `[...]` is a
 * character class and `\x` escapes. With no include patterns every name is
 * included; an include must match for inclusion; any matching exclude drops the
 * name (exclusion wins).
 */
import { compileRefGlob } from '../refs/ref-glob.js';

export interface NameFilter {
  matches(name: string): boolean;
}

export const buildNameFilter = (
  include: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>,
): NameFilter => {
  const includeMatchers = include.map(compileRefGlob);
  const excludeMatchers = exclude.map(compileRefGlob);
  return {
    matches(name: string): boolean {
      const included = includeMatchers.length === 0 || includeMatchers.some((m) => m(name));
      if (!included) return false;
      return !excludeMatchers.some((m) => m(name));
    },
  };
};

export const tagNameMatches = (
  name: string,
  include: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>,
): boolean => buildNameFilter(include, exclude).matches(name);
