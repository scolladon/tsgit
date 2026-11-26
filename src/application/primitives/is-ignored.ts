/**
 * Per-path ignore lookup with rule provenance. Mirrors `git check-ignore -v`.
 *
 * Runs on one `IgnoreSession`, so the global / `info/exclude` / root
 * `.gitignore` files are loaded once per call. Per-directory `.gitignore`
 * rules are read only on the chain above the first excluded leading
 * directory, whose rule then decides the path. The match returns the
 * matching rule's level + index, which we surface as a
 * `source: { kind, basedir, line, pattern }` block when the verdict is
 * "ignored".
 */
import { operationAborted } from '../../domain/error.js';
import type { VerboseMatch } from '../../domain/ignore/matcher-stack.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { createIgnoreSession } from './internal/ignore-evaluator.js';

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

const toIgnoredMatch = (path: FilePath, match: VerboseMatch): IsIgnoredMatch => {
  // Treat anything except an explicit "ignored" verdict as not ignored —
  // `'unset'` and `'unignored'` both collapse to no `source`.
  // `match.level` and `match.ruleIndex` are only populated when verdict !==
  // 'unset', but we narrow on the actual values rather than the verdict so
  // a future refactor of `VerboseMatch` cannot silently break the cast path.
  if (match.verdict !== 'ignored' || match.level === undefined || match.ruleIndex === undefined) {
    return { path, ignored: false };
  }
  const rule = match.level.rules[match.ruleIndex];
  if (rule === undefined) {
    // Stryker disable next-line BooleanLiteral: equivalent — this branch is a noUncheckedIndexedAccess type-narrowing guard; matchInStackVerbose only sets ruleIndex to an in-bounds index (from matchesVerbose/lastMatch), so rule is never undefined at runtime and the literal is never observed.
    return { path, ignored: false };
  }
  return {
    path,
    ignored: true,
    source: {
      kind: match.level.kind ?? 'gitignore',
      basedir: match.level.basedir,
      line: rule.lineNumber,
      pattern: rule.pattern,
    },
  };
};

export const isIgnored = async (
  ctx: Context,
  queries: ReadonlyArray<IsIgnoredQuery>,
): Promise<ReadonlyArray<IsIgnoredMatch>> => {
  if (ctx.signal?.aborted) throw operationAborted();
  if (queries.length === 0) return [];

  const session = await createIgnoreSession(ctx);
  const results: IsIgnoredMatch[] = [];
  for (const query of queries) {
    if (ctx.signal?.aborted) throw operationAborted();
    const match = await session.match(query.path, query.isDirectory === true);
    results.push(toIgnoredMatch(query.path, match));
  }
  return results;
};
