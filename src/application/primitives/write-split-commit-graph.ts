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
  type CommitGraphGeneration,
  type CommitGraphWriterCommit,
  type CorrectedDatePass,
  computeCommitGraphGenerations,
} from '../../domain/commit/commit-graph-writer.js';
import { objectNotFound } from '../../domain/objects/error.js';
import { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { atomicWriteFile, withLockFile } from './atomic-write.js';
import type { NewFilterBudget } from './internal/changed-path-filters.js';
import { changedPathsRequest, configuredMaxNewFilters } from './internal/changed-paths-settings.js';
import { hasGrafts } from './internal/commit-graph-compatible.js';
import {
  type CommitGraphParser,
  closeReachable,
  copyOidsToCommits,
  createCommitGraphParser,
  parsedForWrite,
  refusalFor,
  rootCommits,
} from './internal/commit-graph-passes.js';
import { correctedDatePass } from './internal/corrected-date-pass.js';
import {
  type LocalGraphLayer,
  loadCommitGraphBaseLayers,
} from './internal/local-commit-graph-layers.js';
import { isShallowRepository } from './internal/shallow-set.js';
import {
  commitGraphChainPath,
  commitGraphLayerPath,
  commitGraphLayersDir,
  commitGraphPath,
  commonGitDir,
} from './path-layout.js';
import {
  COMMIT_GRAPH_FILE_MODE,
  changedPathsFor,
  changedPathsSettingsFor,
  commitGraphLocked,
  commitGraphRoots,
  declinesChangedPathsVersion,
  GRAPH_LAYER_SUFFIX,
  isAbsent,
  makeReplaceable,
  removeIfPresent,
  serializeCommitGraphFile,
} from './write-commit-graph.js';

export interface WriteSplitCommitGraphResult {
  /** Whether a layer was written — false when every reachable commit is already in the graph. */
  readonly written: boolean;
  /** Commits the chain holds once the write is done. */
  readonly commitCount: number;
}

const NOTHING_WRITTEN: WriteSplitCommitGraphResult = { written: false, commitCount: 0 };

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

/** git's split `close_reachable` then `copy_oids_to_commits`: a commit a layer already holds is neither followed nor copied. */
async function commitsOutsideGraph(
  ctx: Context,
  parser: CommitGraphParser,
  layers: readonly LocalGraphLayer[],
): Promise<readonly ObjectId[]> {
  const inGraph = (id: ObjectId): boolean => locate(layers, id) !== undefined;
  const roots = await rootCommits(parser, await commitGraphRoots(ctx));
  return copyOidsToCommits(parser, await closeReachable(parser, roots, inGraph), inGraph);
}

/** git's `merge_commit_graph`: a folded layer's commits, minus any whose object is gone. */
async function foldedCommits(
  parser: CommitGraphParser,
  folded: readonly LocalGraphLayer[],
): Promise<readonly ObjectId[]> {
  const commits: ObjectId[] = [];
  for (const { layer } of folded) {
    for (let local = 0; local < layer.commitCount; local += 1) {
      const id = oidAtPosition(layer, local);
      if ((await parser.probe(id)) !== undefined) commits.push(id);
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

/** Where the run of local layers ending at the tip begins. */
function localTipStart(layers: readonly LocalGraphLayer[]): number {
  let start = layers.length;
  while (start > 0 && layers[start - 1]?.local === true) start -= 1;
  return start;
}

/** git's merge walk stops at the first layer from another object source: only the local tip run folds. */
function planSplit(layers: readonly LocalGraphLayer[], newCommitCount: number): SplitPlan {
  const counts = layers.slice(localTipStart(layers)).map(({ layer }) => layer.commitCount);
  const keep = layers.length - mergedLayerCount(counts, newCommitCount);
  return { base: layers.slice(0, keep), folded: layers.slice(keep) };
}

/** git's `sort_and_scan_merged_commits`: one entry per commit in byte order, however many layers held it. */
const mergedOrder = (ids: readonly ObjectId[]): readonly ObjectId[] => [...new Set(ids)].sort();

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
  order: readonly ObjectId[],
  commits: readonly CommitGraphWriterCommit[],
): CommitGraphBase {
  const written = new Set(order);
  const entries = new Map<ObjectId, CommitGraphBaseCommit>();
  for (const parent of commits.flatMap((c) => c.parents)) {
    if (written.has(parent) || entries.has(parent)) continue;
    entries.set(parent, baseCommit(base, parent));
  }
  const commitCount = base.reduce((sum, { layer }) => sum + layer.commitCount, 0);
  return { layerHashes: base.map(({ hash }) => hash), commitCount, commits: entries };
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
  layer: { readonly bytes: Uint8Array; readonly digest: Uint8Array },
): Promise<void> {
  const gitDir = commonGitDir(ctx);
  const layerHash = ObjectId.fromRaw(layer.digest);
  const hashes = [...plan.base.map(({ hash }) => hash), layerHash];
  await ctx.fs.mkdir(commitGraphLayersDir(gitDir));
  const layerPath = commitGraphLayerPath(gitDir, layerHash);
  const chainPath = commitGraphChainPath(gitDir);
  await withLockFile(ctx, chainPath, commitGraphLocked, async (commit) => {
    await makeReplaceable(ctx, layerPath);
    await atomicWriteFile(ctx, layerPath, layer.bytes, commitGraphLocked);
    await ctx.fs.chmod(layerPath, COMMIT_GRAPH_FILE_MODE);
    await settleSingleFile(ctx, plan.base);
    await makeReplaceable(ctx, chainPath);
    await commit(new TextEncoder().encode(hashes.map((hash) => `${hash}\n`).join('')));
  });
  await ctx.fs.chmod(chainPath, COMMIT_GRAPH_FILE_MODE);
  await expireUnlistedLayers(
    ctx,
    new Set(hashes.map((hash) => `graph-${hash}${GRAPH_LAYER_SUFFIX}`)),
  );
}

/**
 * git's `commit_gen_cmp` key for `commitGraph.maxNewFilters`: the generation
 * the write computes — or, when it computes none, the level a folded commit's
 * graph entry carries and zero for a commit no graph holds yet.
 */
function filterBudget(
  limit: number,
  fresh: ReadonlySet<ObjectId>,
  generations: ReadonlyMap<ObjectId, CommitGraphGeneration>,
  pass: CorrectedDatePass,
): NewFilterBudget {
  const generationOf =
    pass === 'skipped'
      ? (id: ObjectId) => (fresh.has(id) ? 0 : generations.get(id)!.level)
      : (id: ObjectId) => generations.get(id)!.correctedDate;
  return { limit, generationOf };
}

/**
 * No layer is written for a shallow repository or one with a registered
 * graft — git's `commit_graph_compatible` — nor when every reachable commit
 * is already in the graph. Changed-path Bloom filters follow the chain's top
 * layer, or `commitGraph.changedPaths` turns them on.
 */
export async function writeSplitCommitGraph(ctx: Context): Promise<WriteSplitCommitGraphResult> {
  const request = await changedPathsRequest(ctx);
  const maxNewFilters = await configuredMaxNewFilters(ctx);
  if (await isShallowRepository(ctx)) return NOTHING_WRITTEN;
  if (await hasGrafts(ctx)) return NOTHING_WRITTEN;
  if (await declinesChangedPathsVersion(ctx)) return NOTHING_WRITTEN;

  const layers = await loadCommitGraphBaseLayers(ctx);
  const parser = createCommitGraphParser(ctx);
  const fresh = await commitsOutsideGraph(ctx, parser, layers);
  const chainCount = layers.reduce((sum, { layer }) => sum + layer.commitCount, 0);
  if (fresh.length === 0) return { written: false, commitCount: chainCount };
  return writeFreshLayer(ctx, { layers, parser, fresh, request, maxNewFilters });
}

/** Everything the new layer is planned from. */
interface FreshLayerInput {
  readonly layers: Awaited<ReturnType<typeof loadCommitGraphBaseLayers>>;
  readonly parser: CommitGraphParser;
  readonly fresh: ReadonlyArray<ObjectId>;
  readonly request: Awaited<ReturnType<typeof changedPathsRequest>>;
  readonly maxNewFilters: Awaited<ReturnType<typeof configuredMaxNewFilters>>;
}

/** Plan the split, fold the merged layers into the new one, and write it to the chain. */
async function writeFreshLayer(
  ctx: Context,
  { layers, parser, fresh, request, maxNewFilters }: FreshLayerInput,
): Promise<WriteSplitCommitGraphResult> {
  const plan = planSplit(layers, fresh.length);
  const order = mergedOrder([...fresh, ...(await foldedCommits(parser, plan.folded))]);
  const parsed = order.flatMap((id) => parser.parsed(id) ?? []);
  const base = graphBase(plan.base, order, parsed);
  const pass = await correctedDatePass(ctx, layers, plan.base);
  const generations = computeCommitGraphGenerations(order, base, parser, pass);
  const settings = await changedPathsSettingsFor(ctx, layers, request);
  const commits = parsedForWrite(parser, order, refusalFor(settings));
  const budget = filterBudget(maxNewFilters, new Set(fresh), generations, pass);
  const changedPaths = await changedPathsFor(ctx, commits, layers, settings, budget);
  const layer = await serializeCommitGraphFile(ctx, commits, base, changedPaths, generations, pass);
  await writeChainLayer(ctx, plan, layer);
  return { written: true, commitCount: base.commitCount + commits.length };
}
