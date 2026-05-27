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
  if (segments.length <= 1) return [];
  const out: string[] = [];
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
      if (stackedDirs.has(ancestor)) continue;
      stackedDirs.add(ancestor);
      const rules: IgnoreRuleset = await evaluator.loadDirRules(ancestor as FilePath | '');
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
