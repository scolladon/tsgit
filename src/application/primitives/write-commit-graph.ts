/**
 * Writes `objects/info/commit-graph`, byte-identical to
 * `git commit-graph write --reachable` for the same commit set. Sources
 * commits from every resolvable REF (`--reachable`'s root set, distinct
 * from `gc`'s `HEAD + index + reflogs` retention roots) through git's parse
 * passes, each commit read from its object — never from an existing graph,
 * corrupt or not, which would encode a stale generation set instead of a fresh
 * one.
 *
 * @writes
 *   surface: commitGraph
 *   kind:    byte-identical
 *   format:  commit-graph-v1
 */
import type { BloomFilterSettings } from '../../domain/commit/bloom-filter.js';
import {
  type CommitGraphChangedPaths,
  type CommitGraphGeneration,
  type CommitGraphWriterCommit,
  type CorrectedDatePass,
  computeCommitGraphGenerations,
  EMPTY_COMMIT_GRAPH_BASE,
  serializeCommitGraph,
} from '../../domain/commit/commit-graph-writer.js';
import { TsgitError } from '../../domain/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { atomicWriteFile } from './atomic-write.js';
import { enumerateRefs } from './enumerate-refs.js';
import {
  changedPathFilters,
  type NewFilterBudget,
  storedFilterLookup,
} from './internal/changed-path-filters.js';
import {
  type ChangedPathsRequest,
  resolveChangedPathsSettings,
} from './internal/changed-paths-settings.js';
import {
  hasGrafts,
  unsupportedChangedPathsVersion,
  unsupportedChangedPathsWarning,
} from './internal/commit-graph-compatible.js';
import {
  closeReachable,
  copyOidsToCommits,
  createCommitGraphParser,
  parsedForWrite,
  refusalFor,
  rootCommits,
  type UnparsedRefusal,
} from './internal/commit-graph-passes.js';
import { correctedDatePass } from './internal/corrected-date-pass.js';
import {
  type LocalGraphLayer,
  loadCommitGraphBaseLayers,
} from './internal/local-commit-graph-layers.js';
import { peel } from './internal/peel.js';
import { isShallowRepository } from './internal/shallow-set.js';
import {
  commitGraphChainPath,
  commitGraphLayersDir,
  commitGraphPath,
  commonGitDir,
} from './path-layout.js';
import { resolveRefForReading } from './resolve-ref.js';

export interface WriteCommitGraphResult {
  readonly commitCount: number;
}

/** git creates every commit-graph file — single file, layer, chain — read-only. */
export const COMMIT_GRAPH_FILE_MODE = 0o444;

/**
 * A read-only target cannot be renamed over on Windows; git for Windows
 * clears the bit before replacing, and so does this, before every rewrite.
 */
export async function makeReplaceable(ctx: Context, path: string): Promise<void> {
  try {
    await ctx.fs.chmod(path, WRITABLE_FILE_MODE);
  } catch (error) {
    if (errorDataCode(error) !== 'FILE_NOT_FOUND') throw error;
  }
}

const WRITABLE_FILE_MODE = 0o644;

export const commitGraphLocked = (lockPath: string): TsgitError =>
  new TsgitError({ code: 'RESOURCE_LOCKED', resource: 'commit-graph', path: lockPath });

/**
 * git's `add_ref_to_set` over `refs_for_each_ref`: every ref peeled through
 * its tags (matching `--reachable`) that names a commit — refs-only, not
 * gc's wider retention roots. A ref that does not resolve for reading
 * (garbage, a dangling symref) is skipped by the iterator; a tag chain that
 * does not peel leaves the tag, never a commit. Any other failure propagates.
 */
export async function commitGraphRoots(ctx: Context): Promise<readonly ObjectId[]> {
  const refNames = await enumerateRefs(ctx);
  const roots = new Set<ObjectId>();
  for (const name of refNames) {
    const id = await resolveRefForReading(ctx, name);
    const root = id === undefined ? undefined : await peeledCommit(ctx, id);
    if (root !== undefined) roots.add(root);
  }
  return [...roots];
}

/** Failures that leave a ref naming no commit: a missing or non-commit end, a tag that does not parse. */
const NO_COMMIT_CODES: ReadonlySet<string> = new Set([
  'OBJECT_NOT_FOUND',
  'INVALID_OBJECT_ID',
  'INVALID_TAG',
]);

const peeledCommit = async (ctx: Context, id: ObjectId): Promise<ObjectId | undefined> => {
  try {
    return await peel(ctx, undefined, id, 'commit');
  } catch (error) {
    if (NO_COMMIT_CODES.has(errorDataCode(error) ?? '')) return undefined;
    throw error;
  }
};

const NOT_IN_GRAPH = (): boolean => false;

interface ParsedGraphCommits {
  readonly commits: readonly CommitGraphWriterCommit[];
  readonly generations: ReadonlyMap<ObjectId, CommitGraphGeneration>;
}

/**
 * git's non-split passes, each commit parsed without the graph: the reachable
 * closure, its copy in byte order, both generation walks, then the entry
 * write that refuses the first commit that did not parse.
 */
async function collectCommits(
  ctx: Context,
  roots: readonly ObjectId[],
  pass: CorrectedDatePass,
  refuse: UnparsedRefusal,
): Promise<ParsedGraphCommits> {
  const parser = createCommitGraphParser(ctx);
  const closed = await closeReachable(parser, await rootCommits(parser, roots), NOT_IN_GRAPH);
  const order = await copyOidsToCommits(parser, closed, NOT_IN_GRAPH);
  const generations = computeCommitGraphGenerations(order, EMPTY_COMMIT_GRAPH_BASE, parser, pass);
  return { commits: parsedForWrite(parser, order, refuse), generations };
}

/** Warns and answers true when git would decline the write on the version alone. */
export async function declinesChangedPathsVersion(ctx: Context): Promise<boolean> {
  const unsupported = await unsupportedChangedPathsVersion(ctx);
  if (unsupported === undefined) return false;
  ctx.logger?.warn?.(unsupportedChangedPathsWarning(unsupported));
  return true;
}

/** The Bloom filter settings a write carries, from the existing graph's top layer — `undefined` when it carries none. */
export function changedPathsSettingsFor(
  ctx: Context,
  layers: readonly LocalGraphLayer[],
  request: ChangedPathsRequest,
): Promise<BloomFilterSettings | undefined> {
  return resolveChangedPathsSettings(ctx, layers.at(-1)?.layer.bloomSettings, request);
}

/** The Bloom filters a write carries under `settings`, the existing graph's stored filters reused. */
export async function changedPathsFor(
  ctx: Context,
  commits: readonly CommitGraphWriterCommit[],
  layers: readonly LocalGraphLayer[],
  settings: BloomFilterSettings | undefined,
  budget?: NewFilterBudget,
): Promise<CommitGraphChangedPaths | undefined> {
  if (settings === undefined) return undefined;
  const stored = storedFilterLookup(layers, settings);
  return { settings, filters: await changedPathFilters(ctx, commits, settings, stored, budget) };
}

const GRAPH_LAYER_SUFFIX = '.graph';

const isAbsent = (error: unknown): boolean => {
  const code = errorDataCode(error);
  return code === 'FILE_NOT_FOUND' || code === 'NOT_A_DIRECTORY';
};

async function removeIfPresent(ctx: Context, path: string): Promise<void> {
  try {
    await ctx.fs.rm(path);
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
}

async function chainLayerNames(ctx: Context, layersDir: string): Promise<readonly string[]> {
  try {
    const entries = await ctx.fs.readdir(layersDir);
    return entries.filter((entry) => entry.name.endsWith(GRAPH_LAYER_SUFFIX)).map((e) => e.name);
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
}

/**
 * git's `expire_commit_graphs` after a non-split write: the single file now
 * answers every lookup, so the chain manifest and every layer go.
 */
async function expireCommitGraphChain(ctx: Context): Promise<void> {
  const gitDir = commonGitDir(ctx);
  await removeIfPresent(ctx, commitGraphChainPath(gitDir));
  const layersDir = commitGraphLayersDir(gitDir);
  for (const name of await chainLayerNames(ctx, layersDir)) {
    await removeIfPresent(ctx, `${layersDir}/${name}`);
  }
}

/**
 * No file is written for a repository with no commits, or a shallow one —
 * pinned against git 2.55.0 (`git commit-graph write --reachable`, both
 * exit 0 with no `objects/info/commit-graph` produced): an empty commit
 * set encodes nothing worth a file, and a shallow boundary makes the
 * generation-number invariant the graph format itself relies on unsound
 * (a shallow commit's true depth from its full history is unknown). This
 * is checked BEFORE the walk, not after, since a shallow repository never
 * needs one. A registered graft refuses the write likewise. Changed-path
 * Bloom filters are written when the existing graph carries them, as `gc`'s
 * in-process write keeps them.
 */
export async function writeCommitGraph(ctx: Context): Promise<WriteCommitGraphResult> {
  if (await isShallowRepository(ctx)) return { commitCount: 0 };
  if (await hasGrafts(ctx)) return { commitCount: 0 };
  if (await declinesChangedPathsVersion(ctx)) return { commitCount: 0 };

  const roots = await commitGraphRoots(ctx);
  const layers = await loadCommitGraphBaseLayers(ctx);
  const pass = await correctedDatePass(ctx, layers, []);
  const settings = await changedPathsSettingsFor(ctx, layers, 'preserve');
  const { commits, generations } = await collectCommits(ctx, roots, pass, refusalFor(settings));
  if (commits.length === 0) return { commitCount: 0 };

  const changedPaths = await changedPathsFor(ctx, commits, layers, settings);
  const bytes = serializeCommitGraph(
    commits,
    ctx.hashConfig,
    EMPTY_COMMIT_GRAPH_BASE,
    changedPaths,
    generations,
    pass,
  );
  const trailerStart = bytes.length - ctx.hashConfig.digestLength;
  const digest = await ctx.hash.hash(bytes.subarray(0, trailerStart));
  bytes.set(digest, trailerStart);

  const path = commitGraphPath(commonGitDir(ctx));
  await makeReplaceable(ctx, path);
  await atomicWriteFile(ctx, path, bytes, commitGraphLocked);
  await ctx.fs.chmod(path, COMMIT_GRAPH_FILE_MODE);
  await expireCommitGraphChain(ctx);

  return { commitCount: commits.length };
}
