/**
 * The graph `git commit-graph verify` opens for one object source: git's
 * `load_commit_graph_one_fd_st` for the single file, and
 * `load_commit_graph_chain_fd_st` for a chain — each line's layer searched in
 * every source, matched against the layers below it, the walk stopping at the
 * first line that does not load. Every warning the loader prints is a verdict.
 */
import {
  type CommitGraphLayer,
  parseCommitGraphLayer,
} from '../../../../domain/commit/commit-graph.js';
import { commitGraphLoadFailure } from '../../../../domain/commit/commit-graph-load.js';
import type { CommitGraphVerdict } from '../../../../domain/commit/commit-graph-verify.js';
import { errorDataCode } from '../../../../domain/error-data-code.js';
import { bytesToHex } from '../../../../domain/objects/encoding.js';
import type { Context } from '../../../../ports/context.js';
import { isGraphDecodeFailure } from '../../../primitives/internal/read-commit-graph.js';
import type { ObjectSource } from '../../../primitives/object-store.js';
import { commitGraphLayerPathIn } from '../../../primitives/path-layout.js';

export interface ChainLayer {
  readonly layer: CommitGraphLayer;
  /** Commits held by the layers below: this layer's first chain-global position. */
  readonly baseCount: number;
}

export interface LoadedChain {
  /** Base first. */
  readonly layers: ReadonlyArray<ChainLayer>;
  readonly verdicts: ReadonlyArray<CommitGraphVerdict>;
  readonly incomplete: boolean;
}

const HEX_LINE = /^[0-9a-f]+$/i;

/** git's loader refusal first; tsgit's own decode refusal only past every check git makes. */
export function parseLayer(
  bytes: Uint8Array,
  hashLength: number,
): CommitGraphLayer | { readonly check: 'load-failure'; readonly failure: LoadFailure } {
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

type LoadFailure = NonNullable<ReturnType<typeof commitGraphLoadFailure>>;

interface ChainWalk {
  readonly ctx: Context;
  readonly sources: ReadonlyArray<ObjectSource>;
  readonly hexLength: number;
  readonly layers: ChainLayer[];
  readonly oids: string[];
  readonly verdicts: CommitGraphVerdict[];
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
  let valid = true;
  for (let index = 0; index < count && valid; index += 1) {
    valid = await addLine(walk, lines[index] as string);
  }
  return { layers: walk.layers, verdicts: walk.verdicts, incomplete: !valid };
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
