/**
 * The graph git opens for one object source, for reads and `commit-graph verify` alike: git's
 * `load_commit_graph_one_fd_st` for the single file, and
 * `load_commit_graph_chain_fd_st` for a chain — each line's layer searched in
 * every source, matched against the layers below it, the walk stopping at the
 * first line that does not load. Every warning the loader prints is a verdict.
 */
import {
  type CommitGraphLayer,
  parseCommitGraphLayer,
} from '../../../domain/commit/commit-graph.js';
import {
  type CommitGraphLoadFailure,
  commitGraphLoadFailure,
} from '../../../domain/commit/commit-graph-load.js';
import { TsgitError } from '../../../domain/error.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import { bytesToHex } from '../../../domain/objects/encoding.js';
import type { Context } from '../../../ports/context.js';
import type { ObjectSource } from '../object-store.js';
import { commitGraphLayerPathIn } from '../path-layout.js';

export interface ChainLayer {
  readonly layer: CommitGraphLayer;
  /** Commits held by the layers below: this layer's first chain-global position. */
  readonly baseCount: number;
}

/** Every warning git's chain loader prints, each one also a `commit-graph verify` verdict. */
export type ChainLoadVerdict =
  | {
      readonly check: 'layer-load-failure';
      readonly layer: string;
      readonly failure: CommitGraphLoadFailure;
    }
  | { readonly check: 'chain-line-not-hash'; readonly line: string }
  | {
      readonly check:
        | 'chain-no-base-chunk'
        | 'chain-base-chunk-too-small'
        | 'chain-mismatch'
        | 'chain-layer-missing';
    };

export interface LoadedChain {
  /** Base first. */
  readonly layers: ReadonlyArray<ChainLayer>;
  readonly verdicts: ReadonlyArray<ChainLoadVerdict>;
  readonly incomplete: boolean;
  /** The chain line the walk stopped at, when it stopped short. */
  readonly stoppedAt: string | undefined;
}

const HEX_LINE = /^[0-9a-f]+$/i;

/** git's loader refusal first; tsgit's own decode refusal only past every check git makes. */
export function parseLayer(
  bytes: Uint8Array,
  hashLength: number,
): CommitGraphLayer | { readonly check: 'load-failure'; readonly failure: CommitGraphLoadFailure } {
  const failure = commitGraphLoadFailure(bytes, hashLength);
  if (failure !== undefined) return { check: 'load-failure', failure };
  try {
    return parseCommitGraphLayer(bytes);
  } catch (error) {
    if (!isGraphDecodeFailure(error)) throw error;
    const reason = (error as Error).message;
    return { check: 'load-failure', failure: { kind: 'malformed', reason } };
  }
}

/** Decode failures (malformed graph bytes) — never fs errors. `RangeError`
 *  covers out-of-range `DataView` reads from crafted chunk offsets. */
export function isGraphDecodeFailure(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  return error instanceof TsgitError && error.data.code.startsWith('INVALID_COMMIT_GRAPH');
}

interface ChainWalk {
  readonly ctx: Context;
  readonly sources: ReadonlyArray<ObjectSource>;
  readonly hexLength: number;
  readonly layers: ChainLayer[];
  readonly oids: string[];
  readonly verdicts: ChainLoadVerdict[];
}

export async function loadChain(
  ctx: Context,
  sources: ReadonlyArray<ObjectSource>,
  chain: Uint8Array,
): Promise<LoadedChain> {
  const hexLength = ctx.hashConfig.digestLength * 2;
  const walk: ChainWalk = { ctx, sources, hexLength, layers: [], oids: [], verdicts: [] };
  const lines = new TextDecoder().decode(chain).split('\n');
  const count = Math.min(Math.floor(chain.length / (hexLength + 1)), lines.length);
  for (let index = 0; index < count; index += 1) {
    const line = lines[index] as string;
    if (!(await addLine(walk, line))) {
      return { layers: walk.layers, verdicts: walk.verdicts, incomplete: true, stoppedAt: line };
    }
  }
  return { layers: walk.layers, verdicts: walk.verdicts, incomplete: false, stoppedAt: undefined };
}

async function addLine(walk: ChainWalk, line: string): Promise<boolean> {
  const oid = line.slice(0, walk.hexLength);
  if (oid.length < walk.hexLength || !HEX_LINE.test(oid)) {
    walk.verdicts.push({ check: 'chain-line-not-hash', line });
    return false;
  }
  walk.oids.push(oid.toLowerCase());
  const added = await addFromSources(walk, line);
  if (!added) walk.verdicts.push({ check: 'chain-layer-missing' });
  return added;
}

/** The first source holding a loadable layer decides; one that does not fit ends the search. */
async function addFromSources(walk: ChainWalk, line: string): Promise<boolean> {
  for (const source of walk.sources) {
    const layer = await loadLayer(walk, source, line);
    if (layer === undefined) continue;
    const mismatch = chainMismatch(walk, layer);
    if (mismatch !== undefined) {
      walk.verdicts.push({ check: mismatch });
      return false;
    }
    const below = walk.layers.at(-1);
    const baseCount = below === undefined ? 0 : below.baseCount + below.layer.commitCount;
    walk.layers.push({ layer, baseCount });
    return true;
  }
  return false;
}

async function loadLayer(
  walk: ChainWalk,
  source: ObjectSource,
  line: string,
): Promise<CommitGraphLayer | undefined> {
  const bytes = await readIfOpenable(source, commitGraphLayerPathIn(source.objectsDir, line));
  if (bytes === undefined) return undefined;
  const parsed = parseLayer(bytes, walk.ctx.hashConfig.digestLength);
  if (!('check' in parsed)) return parsed;
  walk.verdicts.push({ check: 'layer-load-failure', layer: line, failure: parsed.failure });
  return undefined;
}

/** git's `open_commit_graph`: a layer it cannot open, for any reason, is skipped silently. */
async function readIfOpenable(source: ObjectSource, path: string): Promise<Uint8Array | undefined> {
  try {
    return await source.fs.read(path);
  } catch (error) {
    if (errorDataCode(error) === undefined) throw error;
    return undefined;
  }
}

const trailerOf = (layer: CommitGraphLayer): string =>
  bytesToHex(layer._bytes.subarray(layer._bytes.length - layer._hashLength));

/** git's `add_graph_to_chain`: every line below must name both the loaded layer and this BASE entry. */
function chainMismatch(
  walk: ChainWalk,
  layer: CommitGraphLayer,
): 'chain-no-base-chunk' | 'chain-base-chunk-too-small' | 'chain-mismatch' | undefined {
  const below = walk.layers.length;
  const bases = layer.baseGraphHashes;
  if (below > 0 && bases.length === 0) return 'chain-no-base-chunk';
  if (bases.length < below) return 'chain-base-chunk-too-small';
  for (let index = below - 1; index >= 0; index -= 1) {
    const oid = walk.oids[index];
    const loaded = walk.layers[index] as ChainLayer;
    if (oid !== trailerOf(loaded.layer) || oid !== bases[index]) return 'chain-mismatch';
  }
  return undefined;
}
