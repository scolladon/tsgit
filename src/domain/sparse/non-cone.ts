import type { TokenizedIgnoreLine } from '../ignore/index.js';
import type { FilePath } from '../objects/object-id.js';
import { compileGlob } from '../pathspec/index.js';
import type { SparseMatcher, SparseRule } from './sparse-pattern.js';

/**
 * Compile a tokenised `.gitignore`-syntax line into a `SparseRule`. The glob
 * judges one path level only: a rule never covers descendants itself, they
 * inherit from their directory. `caseFold` folds ASCII case as
 * `core.ignorecase` does.
 */
export const compileSparseRule = (
  tokenized: TokenizedIgnoreLine,
  source: string,
  options: { readonly caseFold?: boolean } = {},
): SparseRule => ({
  source,
  negated: tokenized.negated,
  directoryOnly: tokenized.directoryOnly,
  matcher: compileGlob(tokenized.cleanPattern, {
    anchored: tokenized.anchored,
    caseFold: options.caseFold === true,
  }),
});

/** Last matching rule wins; a directory-only rule never judges a file. */
const verdictOf = (
  rules: ReadonlyArray<SparseRule>,
  path: string,
  isDirectory: boolean,
): boolean | undefined => {
  let verdict: boolean | undefined;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    // `compileGlob` returns a stateless matcher — safe to reuse per call.
    if (rule.matcher.test(path)) verdict = !rule.negated;
  }
  return verdict;
};

const parentOf = (path: string): string | undefined => {
  const slash = path.lastIndexOf('/');
  return slash > 0 ? path.slice(0, slash) : undefined;
};

/**
 * Build a matcher for a list of non-cone rules, judging level by level as
 * git's directory walk does: each directory is decided by the rules that match
 * it, and a path no rule decides takes the verdict of its nearest decided
 * directory; a path nothing decides is not in the sparse set. A directory's
 * inherited verdict is memoised, so a path costs one rule pass however deep.
 */
export const nonConeMatcher = (rules: ReadonlyArray<SparseRule>): SparseMatcher => {
  const directoryVerdicts = new Map<string, boolean>();

  const directoryVerdict = (directory: string): boolean => {
    const chain: string[] = [];
    let verdict: boolean | undefined;
    for (
      let level: string | undefined = directory;
      level !== undefined && verdict === undefined;
      level = parentOf(level)
    ) {
      chain.push(level);
      verdict = directoryVerdicts.get(level) ?? verdictOf(rules, level, true);
    }
    const resolved = verdict ?? false;
    for (const level of chain) directoryVerdicts.set(level, resolved);
    return resolved;
  };

  return (path: FilePath): boolean => {
    const own = verdictOf(rules, path, false);
    if (own !== undefined) return own;
    const parent = parentOf(path);
    return parent === undefined ? false : directoryVerdict(parent);
  };
};
