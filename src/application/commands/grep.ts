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
import { boundedMap, MAX_CONCURRENT_BLOB_LOADS } from '../primitives/internal/bounded-map.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import { resolvePathspec } from './internal/resolve-pathspec.js';
import { resolveTreeish } from './internal/resolve-rev.js';

export interface GrepLineHit {
  /** 1-based line number (git's `-n`). */
  readonly lineNumber: number;
  /** Raw returned-line bytes (LF kept by splitLines). */
  readonly line: Uint8Array;
  /** Match byte-offset spans; EMPTY under `invert` (a returned line is a non-match). */
  readonly spans: ReadonlyArray<MatchSpan>;
}

export interface GrepPathResult {
  readonly path: FilePath;
  readonly hits: ReadonlyArray<GrepLineHit>;
  /**
   * Blob is binary AND contained a match. `hits` stays empty — line scan is
   * skipped for binary blobs (git's default). The caller reconstructs
   * "Binary file X matches" from this datum.
   */
  readonly binaryMatch: boolean;
}

export interface GrepResult {
  /** Only paths with ≥1 hit or binaryMatch:true. */
  readonly paths: ReadonlyArray<GrepPathResult>;
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
   * `{ treeish }` ⇒ committed tree.
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

const enumerateWorkingTree = async (ctx: Context): Promise<ReadonlyArray<Candidate>> => {
  const index = await readIndex(ctx);
  const candidates: Candidate[] = [];
  for (const entry of index.entries) {
    if (entry.flags.stage !== 0) continue;
    if (!isSearchableMode(entry.mode)) continue;
    const absPath = joinPath(ctx.layout.workDir, entry.path);
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

async function enumerateCandidates(
  ctx: Context,
  opts: GrepOptions,
): Promise<ReadonlyArray<Candidate>> {
  const { target } = opts;

  if (target === undefined) {
    return enumerateWorkingTree(ctx);
  }

  if (target === 'index') {
    return enumerateIndex(ctx);
  }

  // tree-ish target
  const treeId = await resolveTreeish(ctx, target.treeish);
  const candidates: Candidate[] = [];
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
}

function scanBlob(
  matcher: GrepMatcher,
  binaryProbeMatcher: GrepMatcher,
  path: FilePath,
  bytes: Uint8Array,
): GrepPathResult | undefined {
  if (isBinary(bytes)) {
    // Binary blobs skip line scan. Use the non-inverted probe to check whether
    // the pattern occurs anywhere in the blob — independent of -v, because git
    // reports "Binary file X matches" based on pattern presence, not inversion.
    // Bound the probe to MAX_LINE_BYTES: a presence boolean does not need the whole
    // blob, and an unbounded latin1 scan of a multi-MB blob with a backtracking caller
    // RegExp would block the event loop. Trade-off: a match only beyond the first
    // 64 KiB of a binary blob is not reported (documented in the design).
    const probeVerdict = binaryProbeMatcher.matchLine(bytes.subarray(0, MAX_LINE_BYTES));
    if (!probeVerdict.returned) return undefined;
    return { path, hits: [], binaryMatch: true };
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
  return { path, hits, binaryMatch: false };
}

export async function grep(ctx: Context, opts: GrepOptions): Promise<GrepResult> {
  if (opts.patterns.length === 0) {
    throw invalidOption('patterns', 'at least one pattern required');
  }

  const matcher = buildGrepMatcher(opts.patterns, {
    ...(opts.wholeWord === true ? { wholeWord: true } : {}),
    ...(opts.invert === true ? { invert: true } : {}),
  });

  // Separate non-inverted probe for binary-match detection: git reports
  // "Binary file X matches" based on pattern presence, independent of -v.
  const binaryProbeMatcher = buildGrepMatcher(opts.patterns, {
    ...(opts.wholeWord === true ? { wholeWord: true } : {}),
  });

  const pathspecMatcher =
    opts.paths !== undefined && opts.paths.length > 0 ? resolvePathspec(opts.paths) : undefined;

  const candidates = await enumerateCandidates(ctx, opts);

  const inScope =
    pathspecMatcher !== undefined
      ? candidates.filter(({ path }) => matchesPathspec(pathspecMatcher.matcher, path))
      : candidates;

  const results = await boundedMap(inScope, MAX_CONCURRENT_BLOB_LOADS, async (c) =>
    scanBlob(matcher, binaryProbeMatcher, c.path, await c.load()),
  );
  const paths = results.filter((r): r is GrepPathResult => r !== undefined);
  return { paths };
}
