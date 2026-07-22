/**
 * Per-path ignore lookup with rule provenance. Mirrors `git check-ignore -v`.
 *
 * Reuses `buildIgnoreEvaluator` so the global / `info/exclude` / root
 * `.gitignore` files are loaded once per call, then loads per-directory
 * `.gitignore` rules lazily along each query path's ancestor chain.
 * `matchInStackVerbose` returns the matching rule's level + index, which
 * we surface as a `source: { kind, basedir, line, pattern }` block when
 * the verdict is "ignored" (ADR-163).
 */
import { operationAborted } from '../../domain/error.js';
import {
  type IgnoreLevel,
  type IgnoreRuleset,
  matchInStackVerbose,
} from '../../domain/ignore/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { buildIgnoreEvaluator } from './internal/ignore-evaluator.js';

export interface IsIgnoredQuery {
  readonly path: FilePath;
  /** Match directory rules (`build/`). Defaults to `false`. */
  readonly isDirectory?: boolean;
}

export interface IsIgnoredMatchSource {
  readonly kind: 'global' | 'info' | 'gitignore';
  /** POSIX-relative directory whose file carried the rule. `''` for global / info / repo-root gitignore. */
  readonly basedir: FilePath | '';
  /** 1-based line number of the matching rule inside its file. */
  readonly line: number;
  /** Raw pattern text (e.g. `*.log`, `!keep.log`, `build/`). */
  readonly pattern: string;
}

export interface IsIgnoredMatch {
  readonly path: FilePath;
  readonly ignored: boolean;
  /** Set only when `ignored === true`. */
  readonly source?: IsIgnoredMatchSource;
}

const ancestorsOf = (path: FilePath): ReadonlyArray<string> => {
  const segments = (path as string).split('/');
  // Stryker disable next-line ConditionalExpression,EqualityOperator,ArrayDeclaration: equivalent — split('/') always yields ≥1 segment so `< 1` is unreachable and the early return only skips a zero-iteration loop returning the same []; a placeholder return array names a directory loadDirRules cannot find, so its empty ruleset is never pushed and the verdict/source is unchanged.
  if (segments.length <= 1) return [];
  // Stryker disable next-line ArrayDeclaration: equivalent — a placeholder seed names a directory loadDirRules cannot find, so its empty ruleset is never pushed and the verdict/source is unchanged.
  const out: string[] = [];
  // Stryker disable next-line EqualityOperator: equivalent — the extra iteration seeds the query path itself as an ancestor whose level basedir equals the path; matchInStackVerbose relativizes each level against `basedir + '/'`, so a level whose basedir is the path is always skipped, and deeper sibling queries only pre-load identical rules in the same root-first order — verdict/source unchanged.
  for (let i = 1; i < segments.length; i += 1) {
    out.push(segments.slice(0, i).join('/'));
  }
  return out;
};

export const isIgnored = async (
  ctx: Context,
  queries: ReadonlyArray<IsIgnoredQuery>,
): Promise<ReadonlyArray<IsIgnoredMatch>> => {
  if (ctx.signal?.aborted) throw operationAborted();
  if (queries.length === 0) return [];

  const evaluator = await buildIgnoreEvaluator(ctx);
  const stack: IgnoreLevel[] = [...evaluator.base];
  const stackedDirs = new Set<string>();

  const ensureAncestorRules = async (path: FilePath): Promise<void> => {
    for (const ancestor of ancestorsOf(path)) {
      // Stryker disable next-line ConditionalExpression: equivalent — dropping the skip only re-runs an idempotent Set.add, a cached loadDirRules, and a duplicate identical stack.push; matchInStackVerbose is last-match-wins and every query appends its ancestor chain root-first, so a duplicate level is shadowed by the trailing correct one carrying identical basedir/line/pattern — verdict/source unchanged.
      if (stackedDirs.has(ancestor)) continue;
      stackedDirs.add(ancestor);
      const rules: IgnoreRuleset = await evaluator.loadDirRules(ancestor as FilePath | '');
      // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — forcing the guard always-true only also pushes empty rulesets, which match nothing in matchInStackVerbose, leaving the verdict/source identical.
      if (rules.length > 0) {
        stack.push({ basedir: ancestor as FilePath | '', rules, kind: 'gitignore' });
      }
    }
  };

  const results: IsIgnoredMatch[] = [];
  for (const query of queries) {
    if (ctx.signal?.aborted) throw operationAborted();
    await ensureAncestorRules(query.path);
    const isDir = query.isDirectory === true;
    const match = matchInStackVerbose(stack, query.path, isDir);
    // Treat anything except an explicit "ignored" verdict as not ignored —
    // `'unset'` and `'unignored'` both collapse to no `source` per ADR-163.
    // `match.level` and `match.ruleIndex` are only populated when verdict !==
    // 'unset', but we narrow on the actual values rather than the verdict so
    // a future refactor of `VerboseMatch` cannot silently break the cast path.
    if (match.verdict !== 'ignored' || match.level === undefined || match.ruleIndex === undefined) {
      results.push({ path: query.path, ignored: false });
      continue;
    }
    const rule = match.level.rules[match.ruleIndex];
    if (rule === undefined) {
      // Stryker disable next-line BooleanLiteral: equivalent — this branch is a noUncheckedIndexedAccess type-narrowing guard; matchInStackVerbose only sets ruleIndex to an in-bounds index (from matchesVerbose/lastMatch), so rule is never undefined at runtime and the literal is never observed.
      results.push({ path: query.path, ignored: false });
      continue;
    }
    results.push({
      path: query.path,
      ignored: true,
      source: {
        kind: match.level.kind ?? 'gitignore',
        basedir: match.level.basedir,
        line: rule.lineNumber,
        pattern: rule.pattern,
      },
    });
  }
  return results;
};
