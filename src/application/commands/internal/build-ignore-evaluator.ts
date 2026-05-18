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
 * ADR-033. Per-directory `.gitignore` files are NOT loaded eagerly — the
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
  const stackedDirs = new Set<string>([]);
  return async (path, isDirectory) => {
    for (const ancestor of ancestorsOf(path)) {
      if (stackedDirs.has(ancestor)) continue;
      stackedDirs.add(ancestor);
      const rules = await evaluator.loadDirRules(ancestor as FilePath | '');
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
  if (segments.length <= 1) return [];
  const out: string[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    out.push(segments.slice(0, i).join('/'));
  }
  return out;
};
