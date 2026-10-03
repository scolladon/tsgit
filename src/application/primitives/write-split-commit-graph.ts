/**
 * Writes one split commit-graph layer, as `git commit-graph write --split
 * --reachable` — the write git's `maintenance` commit-graph task runs. The
 * layer holds every ref-reachable commit no existing layer holds, folded
 * together with the tip layers git's default merge strategy absorbs; the
 * layers left below become its base. `commit-graph-chain` then names the
 * layers base first, a single-file base is renamed into the chain, and every
 * `.graph` the chain no longer names is expired.
 *
 * @writes
 *   surface: commitGraph
 *   kind:    byte-identical
 *   format:  commit-graph-v1
 */
import { commitDataAt, oidAtPosition, positionOf } from '../../domain/commit/commit-graph.js';
import { mergedLayerCount } from '../../domain/commit/commit-graph-split.js';
import {
  type CommitGraphBase,
  type CommitGraphBaseCommit,
  type CommitGraphChangedPaths,
  type CommitGraphWriterCommit,
  serializeCommitGraph,
} from '../../domain/commit/commit-graph-writer.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import { isObjectNotFound, objectNotFound } from '../../domain/objects/error.js';
import { type Commit, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { withLockFile } from './atomic-write.js';
import { changedPathsRequest } from './internal/changed-paths-settings.js';
import { hasGrafts } from './internal/commit-graph-compatible.js';
import {
  type LocalGraphLayer,
  loadLocalCommitGraphLayers,
} from './internal/local-commit-graph-layers.js';
import { isShallowRepository } from './internal/shallow-set.js';
import {
  commitGraphChainPath,
  commitGraphLayerPath,
  commitGraphLayersDir,
  commitGraphPath,
  commonGitDir,
} from './path-layout.js';
import { readObject } from './read-object.js';
import {
  changedPathsFor,
  commitGraphLocked,
  commitGraphRoots,
  declinesChangedPathsVersion,
} from './write-commit-graph.js';

export interface WriteSplitCommitGraphResult {
  /** Whether a layer was written — false when every reachable commit is already in the graph. */
  readonly written: boolean;
  /** Commits the chain holds once the write is done. */
  readonly commitCount: number;
}

const NOTHING_WRITTEN: WriteSplitCommitGraphResult = { written: false, commitCount: 0 };

const GRAPH_LAYER_SUFFIX = '.graph';
const MS_PER_SECOND = 1000;

interface LayerSlot {
  readonly layer: LocalGraphLayer['layer'];
  readonly local: number;
  /** Chain-global: the commits of every layer below, plus `local`. */
  readonly position: number;
}

/** Where `layers` hold `id`, or `undefined` when none does. */
function locate(layers: readonly LocalGraphLayer[], id: ObjectId): LayerSlot | undefined {
  let offset = 0;
  for (const { layer } of layers) {
    const local = positionOf(layer, id);
    if (local !== undefined) return { layer, local, position: offset + local };
    offset += layer.commitCount;
  }
  return undefined;
}

const writerCommit = (commit: Commit): CommitGraphWriterCommit => ({
  id: commit.id,
  rootTree: commit.data.tree,
  parents: commit.data.parents,
  committerDate: commit.data.committer.timestamp,
});

/** The commit `id` names, or `undefined` for a ref peeling to a tree or blob; a missing object refuses. */
async function commitIfCommit(ctx: Context, id: ObjectId): Promise<Commit | undefined> {
  const object = await readObject(ctx, id);
  return object.type === 'commit' ? object : undefined;
}

/** git's `lookup_commit_reference_gently`: as {@link commitIfCommit}, a missing object reading as none. */
async function survivingCommit(ctx: Context, id: ObjectId): Promise<Commit | undefined> {
  try {
    return await commitIfCommit(ctx, id);
  } catch (error) {
    if (isObjectNotFound(error)) return undefined;
    throw error;
  }
}

/** git's split `close_reachable`: the walk from the roots stops at any commit a layer already holds. */
async function commitsOutsideGraph(
  ctx: Context,
  layers: readonly LocalGraphLayer[],
): Promise<readonly CommitGraphWriterCommit[]> {
  const pending = [...(await commitGraphRoots(ctx))];
  const seen = new Set<ObjectId>();
  const found: CommitGraphWriterCommit[] = [];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id) || locate(layers, id) !== undefined) continue;
    seen.add(id);
    const commit = await commitIfCommit(ctx, id);
    if (commit === undefined) continue;
    found.push(writerCommit(commit));
    pending.push(...commit.data.parents);
  }
  return found;
}

/** git's `merge_commit_graph`: a folded layer's commits, minus any whose object is gone. */
async function foldedCommits(
  ctx: Context,
  folded: readonly LocalGraphLayer[],
): Promise<readonly CommitGraphWriterCommit[]> {
  const commits: CommitGraphWriterCommit[] = [];
  for (const { layer } of folded) {
    for (let local = 0; local < layer.commitCount; local += 1) {
      const id = oidAtPosition(layer, local);
      const commit = await survivingCommit(ctx, id);
      if (commit !== undefined) commits.push(writerCommit(commit));
    }
  }
  return commits;
}

interface SplitPlan {
  /** Layers kept below the new one, base first. */
  readonly base: readonly LocalGraphLayer[];
  /** Tip layers folded into the new one. */
  readonly folded: readonly LocalGraphLayer[];
}

function planSplit(layers: readonly LocalGraphLayer[], newCommitCount: number): SplitPlan {
  const counts = layers.map(({ layer }) => layer.commitCount);
  const keep = layers.length - mergedLayerCount(counts, newCommitCount);
  return { base: layers.slice(0, keep), folded: layers.slice(keep) };
}

/** git's `sort_and_scan_merged_commits`: one entry per commit, however many layers held it. */
const uniqueCommits = (
  commits: readonly CommitGraphWriterCommit[],
): readonly CommitGraphWriterCommit[] => [...new Map(commits.map((c) => [c.id, c])).values()];

/** A parent neither written nor in the base was a folded commit whose object is gone —
 *  git stops there too (`missing parent`), the layer being unwritable. */
function baseCommit(base: readonly LocalGraphLayer[], id: ObjectId): CommitGraphBaseCommit {
  const slot = locate(base, id);
  if (slot === undefined) throw objectNotFound(id);
  const { layer, local, position } = slot;
  const level = commitDataAt(layer, local, { correctedCommitDates: false }).generation;
  const correctedDate = commitDataAt(layer, local, { correctedCommitDates: true }).generation;
  return { position, generation: { level, correctedDate } };
}

function graphBase(
  base: readonly LocalGraphLayer[],
  commits: readonly CommitGraphWriterCommit[],
): CommitGraphBase {
  const written = new Set(commits.map((c) => c.id));
  const entries = new Map<ObjectId, CommitGraphBaseCommit>();
  for (const parent of commits.flatMap((c) => c.parents)) {
    if (written.has(parent) || entries.has(parent)) continue;
    entries.set(parent, baseCommit(base, parent));
  }
  const commitCount = base.reduce((sum, { layer }) => sum + layer.commitCount, 0);
  return { layerHashes: base.map(({ hash }) => hash), commitCount, commits: entries };
}

async function serializeLayer(
  ctx: Context,
  commits: readonly CommitGraphWriterCommit[],
  base: CommitGraphBase,
  changedPaths: CommitGraphChangedPaths | undefined,
): Promise<{ readonly bytes: Uint8Array; readonly hash: ObjectId }> {
  const bytes = serializeCommitGraph(commits, ctx.hashConfig, base, changedPaths);
  const trailerStart = bytes.length - ctx.hashConfig.digestLength;
  const digest = await ctx.hash.hash(bytes.subarray(0, trailerStart));
  bytes.set(digest, trailerStart);
  return { bytes, hash: ObjectId.fromRaw(digest) };
}

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

/** A single-file base moves into the chain under its trailing hash; with no base it is simply dropped. */
async function settleSingleFile(ctx: Context, base: readonly LocalGraphLayer[]): Promise<void> {
  const gitDir = commonGitDir(ctx);
  const single = commitGraphPath(gitDir);
  const top = base[base.length - 1];
  if (top === undefined) return removeIfPresent(ctx, single);
  if (top.path === single) await ctx.fs.rename(single, commitGraphLayerPath(gitDir, top.hash));
}

/** git's `expire_commit_graphs` at the default expiry: every `.graph` the chain no longer names
 *  goes, unless its mtime is still in the future. */
async function expireUnlistedLayers(ctx: Context, listed: ReadonlySet<string>): Promise<void> {
  const layersDir = commitGraphLayersDir(commonGitDir(ctx));
  const nowSeconds = Math.floor(Date.now() / MS_PER_SECOND);
  for (const { name } of await ctx.fs.readdir(layersDir)) {
    if (!name.endsWith(GRAPH_LAYER_SUFFIX) || listed.has(name)) continue;
    const path = `${layersDir}/${name}`;
    const mtimeSeconds = await mtimeSecondsIfPresent(ctx, path);
    if (mtimeSeconds === undefined || mtimeSeconds > nowSeconds) continue;
    await ctx.fs.rm(path);
  }
}

async function mtimeSecondsIfPresent(ctx: Context, path: string): Promise<number | undefined> {
  try {
    return Math.floor((await ctx.fs.stat(path)).mtimeMs / MS_PER_SECOND);
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
}

async function writeChainLayer(
  ctx: Context,
  plan: SplitPlan,
  layer: { readonly bytes: Uint8Array; readonly hash: ObjectId },
): Promise<void> {
  const gitDir = commonGitDir(ctx);
  const hashes = [...plan.base.map(({ hash }) => hash), layer.hash];
  await ctx.fs.mkdir(commitGraphLayersDir(gitDir));
  await withLockFile(ctx, commitGraphChainPath(gitDir), commitGraphLocked, async (commit) => {
    await ctx.fs.write(commitGraphLayerPath(gitDir, layer.hash), layer.bytes);
    await settleSingleFile(ctx, plan.base);
    await commit(new TextEncoder().encode(hashes.map((hash) => `${hash}\n`).join('')));
  });
  await expireUnlistedLayers(
    ctx,
    new Set(hashes.map((hash) => `graph-${hash}${GRAPH_LAYER_SUFFIX}`)),
  );
}

/**
 * No layer is written for a shallow repository or one with a registered
 * graft — git's `commit_graph_compatible` — nor when every reachable commit
 * is already in the graph. Changed-path Bloom filters follow the chain's top
 * layer, or `commitGraph.changedPaths` turns them on.
 */
export async function writeSplitCommitGraph(ctx: Context): Promise<WriteSplitCommitGraphResult> {
  const request = await changedPathsRequest(ctx);
  if (await isShallowRepository(ctx)) return NOTHING_WRITTEN;
  if (await hasGrafts(ctx)) return NOTHING_WRITTEN;
  if (await declinesChangedPathsVersion(ctx)) return NOTHING_WRITTEN;

  const layers = await loadLocalCommitGraphLayers(ctx);
  const fresh = await commitsOutsideGraph(ctx, layers);
  const chainCount = layers.reduce((sum, { layer }) => sum + layer.commitCount, 0);
  if (fresh.length === 0) return { written: false, commitCount: chainCount };

  const plan = planSplit(layers, fresh.length);
  const commits = uniqueCommits([...fresh, ...(await foldedCommits(ctx, plan.folded))]);
  const base = graphBase(plan.base, commits);
  const changedPaths = await changedPathsFor(ctx, commits, layers.at(-1), request);
  await writeChainLayer(ctx, plan, await serializeLayer(ctx, commits, base, changedPaths));
  return { written: true, commitCount: base.commitCount + commits.length };
}
