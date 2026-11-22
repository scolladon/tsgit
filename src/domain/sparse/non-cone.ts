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
 * non-recursive rule compiles with a plain `$`. `caseFold` folds ASCII case
 * as `core.ignorecase` does.
 */
export const compileSparseRule = (
  tokenized: TokenizedIgnoreLine,
  source: string,
  options: { readonly caseFold?: boolean } = {},
): SparseRule => {
  const recursive = isRecursive(tokenized);
  return {
    source,
    negated: tokenized.negated,
    matcher: compileGlob(tokenized.cleanPattern, {
      anchored: tokenized.anchored,
      withDirSuffix: recursive,
      caseFold: options.caseFold === true,
    }),
  };
};

const verdictOf = (rules: ReadonlyArray<SparseRule>, path: string): boolean | undefined => {
  let verdict: boolean | undefined;
  for (const rule of rules) {
    // `compileGlob` returns a stateless matcher — safe to reuse per call.
    if (rule.matcher.test(path)) verdict = !rule.negated;
  }
  return verdict;
};

/** The enclosing directories of `path`, nearest first. */
function* ancestorsOf(path: string): Generator<string> {
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
    yield path.slice(0, slash);
  }
}

/**
 * Build a matcher for a list of non-cone rules. Last-match-wins over the
 * rules in file order. A path no rule decides takes the verdict of its nearest
 * decided directory, as git's directory walk hands its default down; a path
 * nothing decides is not in the sparse set.
 */
export const nonConeMatcher = (rules: ReadonlyArray<SparseRule>): SparseMatcher => {
  return (path: FilePath): boolean => {
    const own = verdictOf(rules, path);
    if (own !== undefined) return own;
    for (const directory of ancestorsOf(path)) {
      const inherited = verdictOf(rules, directory);
      if (inherited !== undefined) return inherited;
    }
    return false;
  };
};
