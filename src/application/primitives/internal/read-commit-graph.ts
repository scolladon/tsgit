/**
 * Read-side commit-graph support. Serves `root-tree / parents /
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
  type CommitGraphLayer,
  commitMetaAt,
  graphParentsAt,
  oidAtPosition,
  parseCommitGraphLayer,
  positionOf,
} from '../../../domain/commit/commit-graph.js';
import { invalidCommitGraphChunk } from '../../../domain/commit/error.js';
import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry } from '../config-read.js';
import { getObjectStore, type ObjectSource, type ObjectStore } from '../object-store.js';
import { commitGraphChainPathIn, commitGraphPathIn } from '../path-layout.js';
import {
  type ChainLoadVerdict,
  isGraphDecodeFailure,
  loadChain as loadGraphChain,
  parseLayer,
} from './commit-graph-chain.js';
import { assertRepoSettingsValid, repoSettingsVerdictSettled } from './repo-settings-gate.js';

const COMMIT_GRAPH_KEY = 'commitGraph';

import { isShallowRepository } from './shallow-set.js';

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
  /**
   * Git's `validate_mixed_generation_chain` verdict: corrected commit dates are
   * served only when EVERY layer carries a GDA2 chunk. One
   * `commitGraph.generationVersion=1` layer anywhere in the chain demotes the
   * whole chain to topological levels — a corrected date and a topological
   * level are not comparable, so mixing them would order a walk by nonsense.
   */
  readonly correctedCommitDates: boolean;
}

function loadedGraph(layers: readonly CommitGraphLayer[]): LoadedGraph {
  return {
    layers,
    layerOffsets: computeLayerOffsets(layers),
    correctedCommitDates: layers.every((layer) => layer._generationDataRange !== undefined),
  };
}

// Keyed by session so a long-running (or repeated) walk parses the graph
// files at most once per repo lifetime, shared across every Context derived
// from the same repository-open — mirrors `registryCache` in read-object.ts.
const graphCache = new WeakMap<Context['session'], Promise<LoadedGraph | undefined>>();
/** Sessions whose graph probe already answered "absent" — the synchronous
 *  mirror of a memoised `undefined` in `graphCache`, so a graph-first reader
 *  can skip the probe (and its microtask hop) on every later commit. */
const absentGraphs = new WeakSet<Context['session']>();

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
// Insertion-order (FIFO) bound over a plain Map rather than an LRU: a
// commit-graph walk touches each oid roughly once, so recency ordering never
// repays its per-entry node bookkeeping — at the cap that bookkeeping alone
// costs ~2 MiB. Map iteration order is insertion order, so evicting
// `keys().next()` drops the oldest entry in O(1) with zero extra structure.
const headerCache = new WeakMap<Context['session'], Map<ObjectId, CommitHeader>>();

/**
 * Insert into an insertion-order-bounded Map: when the map is at `cap`,
 * evict the oldest entry (Map iteration order is insertion order) before
 * inserting. Overwriting an existing key never evicts — the size does not
 * grow. Precondition: `cap >= 1` — a full map always has a first key, so the
 * eviction loop always finds one and breaks.
 */
export function insertBounded<K, V>(map: Map<K, V>, cap: number, key: K, value: V): void {
  if (!map.has(key) && map.size >= cap) {
    for (const oldest of map.keys()) {
      map.delete(oldest);
      break;
    }
  }
  map.set(key, value);
}

type SourceFs = ObjectSource['fs'];

/** git's open of a graph path under a non-directory fails ENOTDIR: no graph there either. */
function isAbsentPath(error: unknown): boolean {
  const code = errorDataCode(error);
  return code === 'FILE_NOT_FOUND' || code === 'NOT_A_DIRECTORY';
}

// `exists` gates the read so the overwhelmingly common "no commit-graph in
// this repo" case costs a presence check, not a failed read — real git
// consumers (e.g. `describe`'s early-termination test) budget strictly on
// object-read counts, and a commit-graph probe must not spend from that
// budget. The read itself still guards FILE_NOT_FOUND for the narrow TOCTOU
// window between the two calls.
async function tryRead(fs: SourceFs, path: string): Promise<Uint8Array | undefined> {
  try {
    if (!(await fs.exists(path))) return undefined;
    return await fs.read(path);
  } catch (error) {
    if (isAbsentPath(error)) return undefined;
    throw error;
  }
}

/** git's text for each warning its chain loader prints. */
const CHAIN_WARNINGS: Readonly<Record<ChainLoadVerdict['check'], string>> = {
  'layer-load-failure': 'commit-graph file failed to load',
  'chain-line-not-hash': 'invalid commit-graph chain: line not a hash',
  'chain-no-base-chunk': 'commit-graph has no base graphs chunk',
  'chain-base-chunk-too-small': 'commit-graph base graphs chunk is too small',
  'chain-mismatch': 'commit-graph chain does not match',
  'chain-layer-missing': 'unable to find all commit-graph files',
};

/**
 * Git's `load_commit_graph_chain_fd_st`: each chain line (base first) is
 * searched in every source, and the first loadable file must sit on the
 * layers below it (`add_graph_to_chain`). A line that fails warns and stops —
 * the layers loaded so far are served, and an empty prefix is no graph (the
 * caller moves on to the next source).
 */
async function loadChain(
  ctx: Context,
  store: ObjectStore,
  holder: ObjectSource,
): Promise<LoadedGraph | undefined> {
  const chainPath = commitGraphChainPathIn(holder.objectsDir);
  const chain = await tryRead(holder.fs, chainPath);
  if (chain === undefined) return undefined;
  const loaded = await loadGraphChain(ctx, store.sources, chain);
  for (const { check, ...detail } of loaded.verdicts) {
    ctx.logger?.warn?.(`commitGraph: ${CHAIN_WARNINGS[check]}`, {
      chain: chainPath,
      layer: loaded.stoppedAt,
      ...detail,
    });
  }
  const layers = loaded.layers.map(({ layer }) => layer);
  return layers.length > 0 ? loadedGraph(layers) : undefined;
}

/** A malformed graph file is "not loadable" (git warns and moves on); fs errors never reach here. */
export function parseLayerOrUndefined(bytes: Uint8Array): CommitGraphLayer | undefined {
  try {
    return parseCommitGraphLayer(bytes);
  } catch (error) {
    if (isGraphDecodeFailure(error)) return undefined;
    throw error;
  }
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
  if (!(await commitGraphEnabled(ctx))) return undefined;
  if (await isShallowRepository(ctx)) return undefined;

  const store = await getObjectStore(ctx);
  for (const source of store.sources) {
    const graph = await readGraphOne(ctx, store, source);
    if (graph === undefined) continue;
    warnGenerationMisfits(ctx, graph);
    return graph;
  }
  return undefined;
}

function warnGenerationMisfits(ctx: Context, graph: LoadedGraph): void {
  for (const layer of graph.layers) {
    if (layer.generationDataMisfit) {
      ctx.logger?.warn?.('commitGraph: commit-graph generations chunk is wrong size');
    }
  }
}

/**
 * git's `core.commitGraph` (default true), read before any graph file: false
 * leaves every graph unread. A malformed value reads as enabled here; its
 * refusal belongs to git's repo-settings prologue.
 */
export async function commitGraphEnabled(ctx: Context): Promise<boolean> {
  const last = await findLastEntry(ctx, 'core', COMMIT_GRAPH_KEY);
  if (last === undefined) return true;
  const parsed = parseGitBoolean(last.value);
  return !parsed.ok || parsed.value;
}

/** Git's `read_commit_graph_one`: the single file, else the chain. A corrupt
 *  single file is no graph from this source's single slot — the chain is tried. */
async function readGraphOne(
  ctx: Context,
  store: ObjectStore,
  source: ObjectSource,
): Promise<LoadedGraph | undefined> {
  const path = commitGraphPathIn(source.objectsDir);
  const single = await tryRead(source.fs, path);
  const parsed = single === undefined ? undefined : parseLayer(single, ctx.hashConfig.digestLength);
  if (parsed !== undefined && !('check' in parsed)) return loadedGraph([parsed]);
  if (parsed !== undefined) {
    ctx.logger?.warn?.(`commitGraph: ${CHAIN_WARNINGS['layer-load-failure']}`, {
      path,
      failure: parsed.failure,
    });
  }
  return loadChain(ctx, store, source);
}

function loadGraph(ctx: Context): Promise<LoadedGraph | undefined> {
  let cached = graphCache.get(ctx.session);
  if (cached === undefined) {
    cached = loadGraphUncached(ctx);
    graphCache.set(ctx.session, cached);
    // Never memoize a rejection: a transient fs failure must not permanently
    // poison every later commit walk for this repository.
    cached.then(
      (graph) => {
        if (graph === undefined) absentGraphs.add(ctx.session);
      },
      () => graphCache.delete(ctx.session),
    );
  }
  return cached;
}

/**
 * Git's `corrected_commit_dates_enabled`: whether the generations this module
 * serves are corrected commit dates (comparable with committer seconds) or
 * mere topological levels. A walk that orders its queue by generation must ask
 * first — git swaps in its date-only comparator when the answer is `false`.
 *
 * Git also answers `false` for a graph that covers no commits at all; tsgit
 * needs no such clause, because a commit no graph covers already resolves to
 * `GENERATION_NUMBER_INFINITY`. With every generation equal and infinite, the
 * generation clause of any comparator ties on every pair and falls straight
 * through to the date clause, so the two verdicts are indistinguishable.
 */
export async function correctedCommitDatesEnabled(ctx: Context): Promise<boolean> {
  if (!repoSettingsVerdictSettled(ctx)) await assertRepoSettingsValid(ctx);
  const graph = await loadGraph(ctx);
  return graph?.correctedCommitDates === true;
}

function getHeaderCache(ctx: Context): Map<ObjectId, CommitHeader> {
  let cache = headerCache.get(ctx.session);
  if (cache === undefined) {
    cache = new Map<ObjectId, CommitHeader>();
    headerCache.set(ctx.session, cache);
  }
  return cache;
}

/** Binary-search every layer (base → tip) for `id`'s own position. */
function findOwnPosition(
  graph: LoadedGraph,
  id: ObjectId,
):
  | { readonly layer: CommitGraphLayer; readonly localPos: number; readonly layerIndex: number }
  | undefined {
  for (let i = 0; i < graph.layers.length; i += 1) {
    const layer = graph.layers[i]!;
    const localPos = positionOf(layer, id);
    if (localPos !== undefined) return { layer, localPos, layerIndex: i };
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
      // The own-layer bound in resolveParentIds is the only range guard; here we
      // only resolve which layer owns an already-validated position.
      return { layer: graph.layers[i]!, localPos: globalPos - offset };
    }
  }
  // Stryker disable next-line StringLiteral: equivalent (unreachable) — layerOffsets[0]
  // is always 0 (computeLayerOffsets seeds `cumulative=0` before the first push) and
  // every globalPos read from CDAT/EDGE is a non-negative uint32, so the loop above
  // always matches at (at latest) i=0; this throw's message can never be observed.
  throw invalidCommitGraphChunk(`parent position ${globalPos} out of range`);
}

function resolveParentIds(
  graph: LoadedGraph,
  positions: ReadonlyArray<number>,
  ownBound: number,
): readonly ObjectId[] {
  return positions.map((pos) => {
    // git's `insert_parent_or_die` bounds a parent by the CHILD's own layer:
    // `pos >= g->num_commits + g->num_commits_in_base`. A position naming a
    // commit in a HIGHER layer of the chain cannot exist (a layer only
    // references itself and its bases), so refuse it before resolving;
    // `findLayerForGlobalPosition` then only resolves the owning layer.
    if (pos >= ownBound) {
      // Stryker disable next-line StringLiteral: equivalent — swallowed by
      // commitHeader's degrade-to-absent catch; only the code is observable.
      throw invalidCommitGraphChunk(`invalid parent position ${pos}`);
    }
    const { layer, localPos } = findLayerForGlobalPosition(graph, pos);
    return oidAtPosition(layer, localPos);
  });
}

/** Every commit the graph holds, base layer first — empty when the graph is absent. */
export async function graphCommitIds(ctx: Context): Promise<ReadonlyArray<ObjectId>> {
  if (!repoSettingsVerdictSettled(ctx)) await assertRepoSettingsValid(ctx);
  const graph = await loadGraph(ctx);
  if (graph === undefined) return [];
  return graph.layers.flatMap((layer) =>
    Array.from({ length: layer.commitCount }, (_, localPos) => oidAtPosition(layer, localPos)),
  );
}

/** True once this session's graph probe has answered "absent" (no graph, a
 *  shallow repository, or a graph degraded on a decode fault). A synchronous
 *  read, so callers can skip `commitHeader` outright. */
export function isGraphKnownAbsent(ctx: Context): boolean {
  return absentGraphs.has(ctx.session);
}

/**
 * Graph-only lookup: `undefined` when `id` is not present in the graph, or the
 * graph itself is absent/stale — the caller falls back to a full object read.
 */
export async function commitHeader(ctx: Context, id: ObjectId): Promise<CommitHeader | undefined> {
  if (!repoSettingsVerdictSettled(ctx)) await assertRepoSettingsValid(ctx);
  const cache = getHeaderCache(ctx);
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const graph = await loadGraph(ctx);
  if (graph === undefined) return undefined;

  const found = findOwnPosition(graph, id);
  if (found === undefined) return undefined;
  // git's `fill_commit_graph_info` dies on missing overflow data before any
  // parent is read: that refusal is the caller's, never a graph degrade.
  const meta = commitMetaAt(found.layer, found.localPos, {
    correctedCommitDates: graph.correctedCommitDates,
  });
  try {
    const recorded = graphParentsAt(found.layer, found.localPos);
    const ownBound = graph.layerOffsets[found.layerIndex]! + found.layer.commitCount;
    const parents = resolveParentIds(graph, recorded.positions, ownBound);
    if (recorded.edgesOutOfBounds) {
      // git's `fill_commit_in_graph` errors and parses this one commit from
      // its object instead, keeping the graph for every other commit.
      ctx.logger?.warn?.('commitGraph: commit-graph extra-edges pointer out of bounds', { id });
      return undefined;
    }
    const header: CommitHeader = {
      rootTree: meta.rootTree,
      parents,
      committerDate: meta.committerDate,
      generation: meta.generation,
    };
    insertBounded(cache, HEADER_CACHE_MAX_ENTRIES, id, header);
    return header;
  } catch (error) {
    // A parsed-but-internally-inconsistent graph (out-of-range parent
    // positions, truncated EDGE data) surfaces here; degrade to ABSENT for
    // the rest of the repo lifetime, exactly like a corrupt file on disk.
    if (isGraphDecodeFailure(error)) {
      graphCache.set(ctx.session, Promise.resolve(undefined));
      absentGraphs.add(ctx.session);
      // Headers served from this graph before the fault must not linger: the
      // verdict is "absent for the session", so drop the cache — every later
      // lookup falls through to loadGraph (now absent) and answers from objects.
      headerCache.delete(ctx.session);
      return undefined;
    }
    throw error;
  }
}
