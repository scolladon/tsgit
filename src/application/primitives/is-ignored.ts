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
 *
 * Each query is parsed as git parses a `check-ignore` argument, after the
 * global excludes and `info/exclude` are read and before any `.gitignore`
 * is: the path is normalized (`.`, `..` and doubled separators), one that
 * leaves the repository or lies beyond a symbolic link refuses the call, and
 * the normalized path is the one judged. The result names the path as asked.
 */
import { pathspecBeyondSymlink, pathspecOutsideRepo } from '../../domain/commands/error.js';
import { operationAborted } from '../../domain/error.js';
import type { VerboseMatch } from '../../domain/ignore/matcher-stack.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { normalizePathCopy } from '../../domain/path/normalize-path-copy.js';
import type { Context } from '../../ports/context.js';
import { isPermissionDenied } from './internal/fs-probes.js';
import { createIgnoreSession, readStandardExcludes } from './internal/ignore-evaluator.js';
import {
  beyondSymlink,
  createLeadingPathScanner,
  type LeadingPathScanner,
} from './internal/symlinked-leading-path.js';

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

/** A query with the normalized path git judges in its place. */
interface ParsedQuery {
  readonly query: IsIgnoredQuery;
  readonly judged: FilePath;
}

// git's lstat cache reads a leading directory it may not examine as "not a link".
const liesBeyondSymlink = async (
  scanner: LeadingPathScanner,
  judged: FilePath,
): Promise<boolean> => {
  try {
    return await beyondSymlink(scanner, judged);
  } catch (error) {
    if (isPermissionDenied(error)) return false;
    throw error;
  }
};

const parseQuery = async (
  scanner: LeadingPathScanner,
  query: IsIgnoredQuery,
): Promise<ParsedQuery> => {
  const judged = normalizePathCopy(query.path) as FilePath | undefined;
  if (judged === undefined) throw pathspecOutsideRepo(query.path);
  if (await liesBeyondSymlink(scanner, judged)) throw pathspecBeyondSymlink(query.path);
  return { query, judged };
};

// git parses every argument before it matches any: the first one it refuses, refuses the call.
const parseQueries = async (
  ctx: Context,
  queries: ReadonlyArray<IsIgnoredQuery>,
): Promise<ReadonlyArray<ParsedQuery>> => {
  const scanner = createLeadingPathScanner(ctx);
  const parsed: ParsedQuery[] = [];
  for (const query of queries) parsed.push(await parseQuery(scanner, query));
  return parsed;
};

export const isIgnored = async (
  ctx: Context,
  queries: ReadonlyArray<IsIgnoredQuery>,
): Promise<ReadonlyArray<IsIgnoredMatch>> => {
  if (ctx.signal?.aborted) throw operationAborted();
  if (queries.length === 0) return [];
  const standard = await readStandardExcludes(ctx);
  const parsed = await parseQueries(ctx, queries);

  const session = await createIgnoreSession(ctx, standard);
  const results: IsIgnoredMatch[] = [];
  for (const { query, judged } of parsed) {
    if (ctx.signal?.aborted) throw operationAborted();
    const match = await session.match(judged, query.isDirectory === true);
    results.push(toIgnoredMatch(query.path, match));
  }
  return results;
};
