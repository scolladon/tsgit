/**
 * Read-side commit-graph support (Pin D). Serves `root-tree / parents /
 * generation / committer-date` for a commit straight from a parsed
 * `commit-graph` — either the single-file form (`objects/info/commit-graph`)
 * or the chain/split form (`objects/info/commit-graphs/commit-graph-chain` +
 * one `graph-<hash>.graph` per layer) — so `walkCommits` / `commitDateWalk`
 * can decide frontier/ordering without paying a full object read per commit.
 *
 * A commit absent from the graph (or a graph that is absent/stale) resolves
 * to `undefined`; the caller is responsible for falling back to `readObject`.
 * This module never falls back itself — it only reads the graph.
 */
import {
  type CommitData,
  type CommitGraphLayer,
  commitDataAt,
  parseCommitGraphLayer,
  positionOf,
} from '../../../domain/commit/commit-graph.js';
import { invalidCommitGraphChunk } from '../../../domain/commit/error.js';
import { TsgitError } from '../../../domain/error.js';
import { ObjectId } from '../../../domain/objects/index.js';
import { createLruCache, type LruCache } from '../../../domain/storage/lru-cache.js';
import type { Context } from '../../../ports/context.js';
import {
  commitGraphChainPath,
  commitGraphLayerPath,
  commitGraphPath,
  commonGitDir,
} from '../path-layout.js';
import { isShallowRepository } from './shallow-set.js';

/** `RepositoryConfig.parallelism`'s own default — reused as the prefetch bound. */
export const DEFAULT_PREFETCH_CONCURRENCY = 8;

/** Parents/root-tree/generation/date for one commit, sourced from the commit-graph. */
export interface CommitHeader {
  readonly rootTree: ObjectId;
  readonly parents: readonly ObjectId[];
  readonly committerDate: number;
  readonly generation: number;
}

interface LoadedGraph {
  /** Parsed layers, base → tip (a single-file graph is a one-layer "chain"). */
  readonly layers: readonly CommitGraphLayer[];
  /** Global position offset per layer — layerOffsets[i] + local position = global position. */
  readonly layerOffsets: readonly number[];
}

// Keyed by Context so a long-running (or repeated) walk parses the graph files
// at most once per repo lifetime — mirrors `registryCache` in read-object.ts.
const graphCache = new WeakMap<Context, Promise<LoadedGraph | undefined>>();

// Entry cap mirrors `DEFAULT_DELTA_CACHE_ENTRIES` (`src/index.node.ts`) — the
// repo's existing bound for a per-repository memo cache, reused here rather
// than inventing a second magic number.
const HEADER_CACHE_MAX_ENTRIES = 65_536;

// Per-Repository resolved-header cache (oid → header), populated as the graph
// is consulted. Cheap: avoids repeating the cross-layer position arithmetic
// for an oid every walk in the repo's lifetime re-visits. Entry-capped
// (`HEADER_CACHE_MAX_ENTRIES`) so a full-history walk on a very large repo
// cannot retain one entry per commit forever — eviction is hazard-free
// because a miss is always re-derivable from `graph` (already parsed, held
// by `graphCache`) with zero further `ctx.fs` calls.
//
// Cannot serve a header computed under a stale shallow-gate verdict: every
// entry is populated by `commitHeader` only after `loadGraph(ctx)` resolves,
// and `loadGraph`'s own promise (`graphCache`) is itself computed once, atomically,
// from the shallow presence check at the top of `loadGraphUncached` — the
// graph is either consulted for a Context's *entire* lifetime or never is,
// never a mix. A `.git/shallow` write mid-`Context` (`updateShallow`) is the
// same "stale per-Context cache" class as a graph rewritten mid-`Context` —
// already covered by the "construct a fresh `Context` after every write"
// discipline this module's other caches rely on; it is not a new hazard.
const headerCache = new WeakMap<Context, LruCache<CommitHeader>>();

function isFileNotFound(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND';
}

// `exists` gates the read so the overwhelmingly common "no commit-graph in
// this repo" case costs a presence check, not a failed read — real git
// consumers (e.g. `describe`'s early-termination test) budget strictly on
// object-read counts, and a commit-graph probe must not spend from that
// budget. The read itself still guards FILE_NOT_FOUND for the narrow TOCTOU
// window between the two calls.
async function tryRead(ctx: Context, path: string): Promise<Uint8Array | undefined> {
  if (!(await ctx.fs.exists(path))) return undefined;
  try {
    return await ctx.fs.read(path);
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

async function tryReadUtf8(ctx: Context, path: string): Promise<string | undefined> {
  if (!(await ctx.fs.exists(path))) return undefined;
  try {
    return await ctx.fs.readUtf8(path);
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

function parseChainLayerHashes(chainText: string): readonly string[] {
  return chainText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Load the chain form. A chain that references a layer file which no longer
 * exists is treated as an ABSENT graph (Pin D staleness) — git's own
 * behaviour for a chain with a missing layer (warn + fall back, exit 0).
 */
async function loadChain(ctx: Context, gitDir: string): Promise<LoadedGraph | undefined> {
  const chainText = await tryReadUtf8(ctx, commitGraphChainPath(gitDir));
  if (chainText === undefined) return undefined;

  const hashes = parseChainLayerHashes(chainText);
  // Stryker disable next-line ConditionalExpression: equivalent — dropping this
  // guard falls through to `layers: []`, a 0-layer LoadedGraph. Every consumer
  // (findOwnPosition's `for (i<layers.length)`) treats a 0-layer graph exactly
  // like an absent one — 0 iterations, `undefined` either way — so commitHeader's
  // observable result is identical with or without the early return.
  if (hashes.length === 0) return undefined;

  const layers: CommitGraphLayer[] = [];
  for (const hash of hashes) {
    const bytes = await tryRead(ctx, commitGraphLayerPath(gitDir, hash));
    if (bytes === undefined) return undefined;
    layers.push(parseCommitGraphLayer(bytes));
  }
  return { layers, layerOffsets: computeLayerOffsets(layers) };
}

function computeLayerOffsets(layers: readonly CommitGraphLayer[]): readonly number[] {
  const offsets: number[] = [];
  let cumulative = 0;
  for (const layer of layers) {
    offsets.push(cumulative);
    cumulative += layer.commitCount;
  }
  return offsets;
}

// Git's own `commit_graph_compatible` rule: a shallow repository never
// consults the commit-graph, because a graph layer records the true (pre-cut)
// parent list, and a graph-only walk never reaches `readCommit`'s grafting.
// Gated on FILE PRESENCE, not `(await loadShallowSet(ctx)).size > 0` — an
// empty `.git/shallow` already disables the graph on the git side. The probe
// is itself memoised per `Context` (`shallow-set.ts`), so this costs at most
// one extra `readUtf8` for the lifetime of a `Context`, and it happens here —
// inside the function whose promise `graphCache` stores — so it is paid once
// per repo, never once per oid.
async function loadGraphUncached(ctx: Context): Promise<LoadedGraph | undefined> {
  if (await isShallowRepository(ctx)) return undefined;

  const gitDir = commonGitDir(ctx);

  try {
    const single = await tryRead(ctx, commitGraphPath(gitDir));
    if (single !== undefined) {
      const layer = parseCommitGraphLayer(single);
      return { layers: [layer], layerOffsets: [0] };
    }
    return loadChain(ctx, gitDir);
  } catch (error) {
    // A present-but-corrupt graph is git-faithfully treated as ABSENT (git
    // warns and falls back to object reads, exit 0). Genuine fs failures
    // still propagate.
    if (isGraphDecodeFailure(error)) return undefined;
    throw error;
  }
}

/** Decode failures (malformed graph bytes) — never fs errors. `RangeError`
 *  covers out-of-range `DataView` reads from crafted chunk offsets. */
function isGraphDecodeFailure(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  return error instanceof TsgitError && error.data.code.startsWith('INVALID_COMMIT_GRAPH');
}

function loadGraph(ctx: Context): Promise<LoadedGraph | undefined> {
  let cached = graphCache.get(ctx);
  if (cached === undefined) {
    cached = loadGraphUncached(ctx);
    graphCache.set(ctx, cached);
    // Never memoize a rejection: a transient fs failure must not permanently
    // poison every later commit walk for this repository.
    cached.catch(() => graphCache.delete(ctx));
  }
  return cached;
}

function getHeaderCache(ctx: Context): LruCache<CommitHeader> {
  let cache = headerCache.get(ctx);
  if (cache === undefined) {
    cache = createLruCache<CommitHeader>(Number.POSITIVE_INFINITY, HEADER_CACHE_MAX_ENTRIES);
    headerCache.set(ctx, cache);
  }
  return cache;
}

/** Binary-search every layer (base → tip) for `id`'s own position. */
function findOwnPosition(
  graph: LoadedGraph,
  id: ObjectId,
): { readonly layer: CommitGraphLayer; readonly localPos: number } | undefined {
  for (let i = 0; i < graph.layers.length; i += 1) {
    const layer = graph.layers[i]!;
    const localPos = positionOf(layer, id);
    if (localPos !== undefined) return { layer, localPos };
  }
  return undefined;
}

/** Resolve a GLOBAL position (as recorded in CDAT/EDGE) to its owning layer + local position. */
function findLayerForGlobalPosition(
  graph: LoadedGraph,
  globalPos: number,
): { readonly layer: CommitGraphLayer; readonly localPos: number } {
  // Stryker disable next-line ArithmeticOperator: equivalent — starting at
  // `length + 1` only adds two `graph.layerOffsets[i]` reads past the array end;
  // out-of-bounds array access is `undefined` in JS, and `globalPos >= undefined`
  // is always `false`, so those extra iterations are no-ops that fall through to
  // the same `i = length - 1` starting point, identical for every globalPos.
  for (let i = graph.layers.length - 1; i >= 0; i -= 1) {
    const offset = graph.layerOffsets[i]!;
    if (globalPos >= offset) {
      return { layer: graph.layers[i]!, localPos: globalPos - offset };
    }
  }
  // Stryker disable next-line StringLiteral: equivalent (unreachable) — layerOffsets[0]
  // is always 0 (computeLayerOffsets seeds `cumulative=0` before the first push) and
  // every globalPos read from CDAT/EDGE is a non-negative uint32, so the loop above
  // always matches at (at latest) i=0; this throw's message can never be observed.
  throw invalidCommitGraphChunk(`parent position ${globalPos} out of range`);
}

function oidAtPosition(layer: CommitGraphLayer, localPos: number): ObjectId {
  const offset = layer._oidLookupOffset + localPos * layer._hashLength;
  return ObjectId.fromRaw(layer._bytes.subarray(offset, offset + layer._hashLength));
}

function resolveParentIds(graph: LoadedGraph, data: CommitData): readonly ObjectId[] {
  const positions: number[] = [];
  if (data.parent1Pos !== undefined) positions.push(data.parent1Pos);
  if (data.parent2Pos !== undefined) positions.push(data.parent2Pos);
  positions.push(...data.additionalParentPositions);

  return positions.map((pos) => {
    const { layer, localPos } = findLayerForGlobalPosition(graph, pos);
    return oidAtPosition(layer, localPos);
  });
}

/**
 * Graph-only lookup: `undefined` when `id` is not present in the graph, or the
 * graph itself is absent/stale — the caller falls back to a full object read.
 */
export async function commitHeader(ctx: Context, id: ObjectId): Promise<CommitHeader | undefined> {
  const cache = getHeaderCache(ctx);
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const graph = await loadGraph(ctx);
  if (graph === undefined) return undefined;

  try {
    const found = findOwnPosition(graph, id);
    if (found === undefined) return undefined;

    const data = commitDataAt(found.layer, found.localPos);
    const header: CommitHeader = {
      rootTree: data.rootTree,
      parents: resolveParentIds(graph, data),
      committerDate: data.committerDate,
      generation: data.generation,
    };
    cache.set(id, header, 1);
    return header;
  } catch (error) {
    // A parsed-but-internally-inconsistent graph (out-of-range parent
    // positions, truncated EDGE data) surfaces here; degrade to ABSENT for
    // the rest of the repo lifetime, exactly like a corrupt file on disk.
    if (isGraphDecodeFailure(error)) {
      graphCache.set(ctx, Promise.resolve(undefined));
      return undefined;
    }
    throw error;
  }
}
