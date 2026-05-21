import {
  type IgnoreLevel,
  type IgnoreRuleset,
  matchInStack,
} from '../../../domain/ignore/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import type { IgnorePredicate } from './add-ignore.js';
import { readGitignore, readGlobalExcludes, readInfoExclude } from './read-gitignore.js';

export interface IgnoreEvaluator {
  /** Base levels available before the walk begins (global → info → repo-root, in order). */
  readonly base: ReadonlyArray<IgnoreLevel>;
  /**
   * Lazily load and cache the ruleset for a directory's `.gitignore`.
   * `dir === ''` is the repo root; non-root values are POSIX-relative
   * `FilePath`s (no trailing slash).
   */
  readonly loadDirRules: (dir: FilePath | '') => Promise<IgnoreRuleset>;
}

/**
 * Build an `IgnoreEvaluator` from the four ignore sources documented in
 * . Per-directory `.gitignore` files are NOT loaded eagerly — the
 * caller (typically `buildRepoIgnorePredicate`) loads them on demand
 * during the walk, so subtrees pruned by a parent rule are never read.
 */
export const buildIgnoreEvaluator = async (ctx: Context): Promise<IgnoreEvaluator> => {
  const base: IgnoreLevel[] = [];
  const global = await readGlobalExcludes(ctx);
  if (global !== undefined) base.push({ basedir: '', rules: global });
  const info = await readInfoExclude(ctx);
  if (info !== undefined) base.push({ basedir: '', rules: info });
  const root = await readGitignore(ctx, '');
  if (root !== undefined) base.push({ basedir: '', rules: root });
  const cache = new Map<FilePath | '', IgnoreRuleset>();
  const loadDirRules = async (dir: FilePath | ''): Promise<IgnoreRuleset> => {
    const cached = cache.get(dir);
    if (cached !== undefined) return cached;
    const loaded = (await readGitignore(ctx, dir)) ?? [];
    cache.set(dir, loaded);
    return loaded;
  };
  return { base, loadDirRules };
};

/**
 * Build the ignore predicate used by the walk. The closure owns a
 * mutable stack that grows as the walk descends: every time the
 * predicate sees a path with a previously-unseen ancestor directory,
 * the ancestor's `.gitignore` is loaded (via `loadDirRules`) and
 * pushed onto the stack. Pruned subtrees are never visited, so their
 * `.gitignore` files are never read.
 */
export const buildRepoIgnorePredicate = async (ctx: Context): Promise<IgnorePredicate> => {
  const evaluator = await buildIgnoreEvaluator(ctx);
  const stack: IgnoreLevel[] = [...evaluator.base];
  // Stryker disable next-line ArrayDeclaration: equivalent — any initial Set contents other than `[]` are phantom entries that never equal a real POSIX-relative ancestor path, so `stackedDirs.has(ancestor)` is never affected.
  const stackedDirs = new Set<string>([]);
  return async (path, isDirectory) => {
    for (const ancestor of ancestorsOf(path)) {
      // Stryker disable next-line ConditionalExpression: equivalent — dropping the skip only re-runs an idempotent `Set.add`, a cached `loadDirRules`, and a duplicate identical `stack.push`; `matchInStack` is last-match-wins and every call appends its own ancestor chain root-first, so stale duplicates are always shadowed by that trailing correct chain (verified exhaustively).
      if (stackedDirs.has(ancestor)) continue;
      stackedDirs.add(ancestor);
      const rules = await evaluator.loadDirRules(ancestor as FilePath | '');
      // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — forcing the guard true (or `>= 0`) only also pushes empty rulesets, which never match anything in `matchInStack`, leaving the predicate result identical.
      if (rules.length > 0) {
        stack.push({ basedir: ancestor as FilePath | '', rules });
      }
    }
    return matchInStack(stack, path, isDirectory) === 'ignored';
  };
};

/**
 * Yield each ancestor directory of `path`, root-first, excluding the
 * path itself. For `a/b/c.txt` returns `['a', 'a/b']`. The repo root
 * ancestor is not yielded — its rules live in `evaluator.base`.
 */
const ancestorsOf = (path: FilePath): ReadonlyArray<string> => {
  const segments = path.split('/');
  // Stryker disable next-line ConditionalExpression,EqualityOperator,ArrayDeclaration: equivalent — `split('/')` always yields ≥1 segment so `< 1` is unreachable; the early return only skips a loop that would run zero iterations and return the same empty array anyway.
  if (segments.length <= 1) return [];
  // Stryker disable next-line ArrayDeclaration: equivalent — a non-empty `out` seed is a placeholder that never equals a real POSIX-relative ancestor, so `stackedDirs.has(...)` filters it and it never pushes a level.
  const out: string[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    out.push(segments.slice(0, i).join('/'));
  }
  return out;
};
