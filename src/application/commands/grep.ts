import { invalidOption } from '../../domain/commands/error.js';
import { isBinary, MAX_LINE_BYTES, splitLines } from '../../domain/diff/index.js';
import {
  buildGrepMatcher,
  type GrepMatcher,
  type GrepPattern,
  type MatchSpan,
} from '../../domain/grep/index.js';
import { FILE_MODE } from '../../domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../domain/objects/object-id.js';
import { matchesPathspec } from '../../domain/pathspec/index.js';
import type { Context } from '../../ports/context.js';
import { readBlob, readIndex, walkTree } from '../primitives/index.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import { createObjectTypeTable } from '../primitives/internal/object-type-table.js';
import { peelToTreeOrBlob } from '../primitives/internal/peel.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { resolveCommandPathspec } from './internal/pathspec-intake.js';
import { assertOperationalRepository, requireWorkTree } from './internal/repo-state.js';
import { resolveReference } from './internal/resolve-rev.js';

export interface GrepLineHit {
  /** 1-based line number (git's `-n`). */
  readonly lineNumber: number;
  /** Raw returned-line bytes (LF kept by splitLines). */
  readonly line: Uint8Array;
  /** Match byte-offset spans; EMPTY under `invert` (a returned line is a non-match). */
  readonly spans: ReadonlyArray<MatchSpan>;
}

export interface GrepBlobResult {
  readonly hits: ReadonlyArray<GrepLineHit>;
  /**
   * Blob is binary AND some line of its first 64 KiB is returned by the matcher
   * (`invert`-aware). `hits` stays empty — line scan is skipped for binary blobs
   * (git's default). The caller reconstructs
   * "Binary file X matches" from this datum.
   */
  readonly binaryMatch: boolean;
  /**
   * Lines of a binary blob's first 64 KiB the matcher returns — git's `-c`
   * count for it. `0` for a text blob, whose count is `hits.length`.
   */
  readonly binaryMatchCount: number;
}

export interface GrepPathResult extends GrepBlobResult {
  readonly path: FilePath;
}

export interface GrepResult {
  /** Tree-ish, index and working-tree targets: only paths with ≥1 hit or binaryMatch:true. Always empty for a blob target. */
  readonly paths: ReadonlyArray<GrepPathResult>;
  /** Blob target only: the blob's match; absent when it did not match (git exit 1). */
  readonly blob?: GrepBlobResult;
}

export interface GrepOptions {
  /** Patterns to search. ≥1 required; multiple OR-combine. */
  readonly patterns: ReadonlyArray<GrepPattern>;
  /** Whole-word gating (`-w`). */
  readonly wholeWord?: boolean;
  /** Invert: return lines that do NOT match (`-v`). */
  readonly invert?: boolean;
  /**
   * Target. Absent ⇒ working tree; `'index'` ⇒ `--cached`;
   * `{ treeish }` ⇒ a committed tree, or a blob when
   * the rev resolves to one.
   */
  readonly target?: 'index' | { readonly treeish: string };
  /** Pathspec limiter (`-- <path>...`). */
  readonly paths?: ReadonlyArray<string>;
}

interface Candidate {
  readonly path: FilePath;
  readonly load: () => Promise<Uint8Array>;
}

const isSearchableMode = (mode: string): boolean =>
  mode === FILE_MODE.REGULAR || mode === FILE_MODE.EXECUTABLE;

const enumerateWorkingTree = async (
  ctx: Context,
  workDir: string,
): Promise<ReadonlyArray<Candidate>> => {
  const index = await readIndex(ctx);
  const candidates: Candidate[] = [];
  for (const entry of index.entries) {
    if (entry.flags.stage !== 0) continue;
    if (!isSearchableMode(entry.mode)) continue;
    const absPath = joinPath(workDir, entry.path);
    const stat = await ctx.fs.lstat(absPath).catch(() => undefined);
    // A tracked path absent from the working tree, or whose working-tree entry is no
    // longer a regular file (replaced by a directory or symlink), is skipped — git grep
    // does not descend or follow it and exits 0 without searching it.
    if (stat === undefined || stat.isDirectory || stat.isSymbolicLink) continue;
    candidates.push({
      path: entry.path,
      load: () => ctx.fs.read(absPath),
    });
  }
  return candidates;
};

const enumerateIndex = async (ctx: Context): Promise<ReadonlyArray<Candidate>> => {
  const index = await readIndex(ctx);
  return index.entries
    .filter((entry) => entry.flags.stage === 0 && isSearchableMode(entry.mode))
    .map((entry) => ({
      path: entry.path,
      load: async (): Promise<Uint8Array> => {
        const blob = await readBlob(ctx, entry.id);
        return blob.content;
      },
    }));
};

const enumerateTree = async (ctx: Context, treeId: ObjectId): Promise<ReadonlyArray<Candidate>> => {
  const candidates: Candidate[] = [];
  // Stryker disable next-line ObjectLiteral: equivalent — `walkTree`'s `recursive` option defaults to `true` when omitted (see `walk-tree.ts`), so `{}` and `{ recursive: true }` produce identical traversals.
  for await (const { path, id, mode } of walkTree(ctx, treeId, { recursive: true })) {
    if (!isSearchableMode(mode)) continue;
    const capturedId: ObjectId = id;
    candidates.push({
      path,
      load: async (): Promise<Uint8Array> => {
        const blob = await readBlob(ctx, capturedId);
        return blob.content;
      },
    });
  }
  return candidates;
};

async function enumerateCandidates(
  ctx: Context,
  target: 'index' | undefined,
): Promise<ReadonlyArray<Candidate>> {
  if (target === undefined) {
    // Only the working-tree target needs one — `--cached` and a tree-ish
    // target both stay open in a bare repo (git: `grep --cached <pat>` and
    // `grep <pat> HEAD` both exit 0).
    return enumerateWorkingTree(ctx, requireWorkTree(ctx, 'grep'));
  }
  return enumerateIndex(ctx);
}

// git's binary verdict and -c count: the window's lines the (invert-aware) matcher returns.
// The window bounds a caller RegExp, whose backtracking over a multi-MB binary blob would
// block the event loop; a match only beyond the first 64 KiB is not reported.
const countReturnedLines = (matcher: GrepMatcher, bytes: Uint8Array): number =>
  splitLines(bytes.subarray(0, MAX_LINE_BYTES)).filter((line) => matcher.matchLine(line).returned)
    .length;

function scanBlob(matcher: GrepMatcher, bytes: Uint8Array): GrepBlobResult | undefined {
  if (isBinary(bytes)) {
    const binaryMatchCount = countReturnedLines(matcher, bytes);
    return binaryMatchCount > 0 ? { hits: [], binaryMatch: true, binaryMatchCount } : undefined;
  }

  const lines = splitLines(bytes);
  const hits: GrepLineHit[] = [];
  lines.forEach((line, i) => {
    const verdict = matcher.matchLine(line);
    if (verdict.returned) {
      hits.push({ lineNumber: i + 1, line, spans: verdict.spans });
    }
  });

  if (hits.length === 0) return undefined;
  return { hits, binaryMatch: false, binaryMatchCount: 0 };
}

const grepBlob = async (ctx: Context, matcher: GrepMatcher, id: ObjectId): Promise<GrepResult> => {
  const blob = scanBlob(matcher, (await readBlob(ctx, id)).content);
  return blob === undefined ? { paths: [] } : { paths: [], blob };
};

const scanCandidate = async (
  matcher: GrepMatcher,
  candidate: Candidate,
): Promise<GrepPathResult | undefined> => {
  const match = scanBlob(matcher, await candidate.load());
  return match === undefined ? undefined : { path: candidate.path, ...match };
};

type PathspecMatcher = ReturnType<typeof resolveCommandPathspec>;

const pathspecFor = (
  ctx: Context,
  paths: ReadonlyArray<string> | undefined,
): PathspecMatcher | undefined =>
  paths !== undefined && paths.length > 0 ? resolveCommandPathspec(ctx, paths) : undefined;

const grepCandidates = async (
  ctx: Context,
  matcher: GrepMatcher,
  pathspecMatcher: PathspecMatcher | undefined,
  candidates: ReadonlyArray<Candidate>,
): Promise<GrepResult> => {
  const inScope =
    pathspecMatcher !== undefined
      ? candidates.filter(({ path }) => matchesPathspec(pathspecMatcher.matcher, path))
      : candidates;
  const results = await boundedMapFor(ctx, 'ioBound', inScope, (c) => scanCandidate(matcher, c));
  return { paths: results.filter((r): r is GrepPathResult => r !== undefined) };
};

// git resolves and parses the named object, then the pathspec, and only then peels the
// object: an unresolvable or missing rev outranks a bad pathspec, a failing peel does not.
const grepRev = async (
  ctx: Context,
  matcher: GrepMatcher,
  rev: string,
  paths: ReadonlyArray<string> | undefined,
): Promise<GrepResult> => {
  const table = createObjectTypeTable();
  const named = await resolveReference(ctx, table, rev);
  const pathspecMatcher = pathspecFor(ctx, paths);
  const root = await peelToTreeOrBlob(ctx, table, named);
  // git greps the one blob a rev names; the pathspec is validated but never applied to it.
  if (root.kind === 'blob') return grepBlob(ctx, matcher, root.id);
  return grepCandidates(ctx, matcher, pathspecMatcher, await enumerateTree(ctx, root.id));
};

export async function grep(ctx: Context, opts: GrepOptions): Promise<GrepResult> {
  // Repository state is checked BEFORE the argument guard, because that is the
  // order git refuses in: `git grep` with no pattern, in a repository whose
  // config is malformed, reports the config fault rather than the missing
  // pattern — git parses config at startup, before validating arguments. The
  // repo-settings class is included here for the same reason: a `grep` with
  // no pattern never reaches the tree walk that would otherwise touch it.
  await assertOperationalRepository(ctx);
  await assertRepoSettingsValid(ctx);
  if (opts.patterns.length === 0) {
    throw invalidOption('patterns', 'at least one pattern required');
  }

  const matcher = buildGrepMatcher(opts.patterns, {
    ...(opts.wholeWord === true ? { wholeWord: true } : {}),
    ...(opts.invert === true ? { invert: true } : {}),
  });

  const { target } = opts;
  if (target !== undefined && target !== 'index') {
    return grepRev(ctx, matcher, target.treeish, opts.paths);
  }
  const pathspecMatcher = pathspecFor(ctx, opts.paths);
  return grepCandidates(ctx, matcher, pathspecMatcher, await enumerateCandidates(ctx, target));
}
