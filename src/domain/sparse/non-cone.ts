import type { TokenizedIgnoreLine } from '../ignore/index.js';
import type { FilePath } from '../objects/object-id.js';
import { compileGlob } from '../pathspec/index.js';
import type { SparseMatcher, SparseRule } from './sparse-pattern.js';

/**
 * A non-cone rule is recursive — it covers the named path and every
 * descendant — when it is directory-only OR its final `/`-segment contains
 * no glob metacharacter (`*`/`?`). A wildcard last segment (`/src/*`) covers
 * direct children only.
 */
const isRecursive = (tokenized: TokenizedIgnoreLine): boolean => {
  if (tokenized.directoryOnly) return true;
  const segments = tokenized.cleanPattern.split('/');
  const last = segments[segments.length - 1] as string;
  return !last.includes('*') && !last.includes('?');
};

/**
 * Compile a tokenised `.gitignore`-syntax line into a `SparseRule`. A
 * recursive rule compiles with a `(/.*)?$` descendant suffix; a
 * non-recursive rule compiles with a plain `$`.
 */
export const compileSparseRule = (tokenized: TokenizedIgnoreLine, source: string): SparseRule => {
  const recursive = isRecursive(tokenized);
  return {
    source,
    negated: tokenized.negated,
    regex: compileGlob(tokenized.cleanPattern, {
      anchored: tokenized.anchored,
      withDirSuffix: recursive,
    }),
  };
};

/**
 * Build a matcher for a list of non-cone rules. Last-match-wins over the
 * rules in file order; a path matched by no rule is not in the sparse set.
 */
export const nonConeMatcher = (rules: ReadonlyArray<SparseRule>): SparseMatcher => {
  return (path: FilePath): boolean => {
    let included = false;
    for (const rule of rules) {
      // `compileGlob` produces a regex with no `g`/`y` flag, so `.test()` keeps
      // no `lastIndex` state — it is safe to reuse the same regex per call.
      if (rule.regex.test(path)) included = !rule.negated;
    }
    return included;
  };
};
