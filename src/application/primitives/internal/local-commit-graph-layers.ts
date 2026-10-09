/**
 * The commit-graph a split write builds on: git's `prepare_commit_graph` —
 * the first object source, local first then each alternate, holding a graph:
 * its single `info/commit-graph` file when it loads, otherwise its chain's
 * layers base first, each found in whichever source holds it, stopping at
 * the first layer no source loads. An alternate's single file is no base:
 * a chain cannot name it where it sits, so the write stands alone over it.
 */
import type { CommitGraphLayer } from '../../../domain/commit/commit-graph.js';
import { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { getObjectStore, type ObjectSource } from '../object-store.js';
import {
  commitGraphChainPathIn,
  commitGraphLayerPathIn,
  commitGraphPathIn,
} from '../path-layout.js';
import { isAbsent, readUtf8IfPresent } from './fs-probes.js';
import { parseLayerOrUndefined } from './read-commit-graph.js';

export interface LocalGraphLayer {
  /** The file's trailing checksum — the name a chain gives the layer. */
  readonly hash: ObjectId;
  readonly path: string;
  readonly layer: CommitGraphLayer;
  /** Found in the repository's own object directory — only such a layer may be merged or moved. */
  readonly local: boolean;
}

/** A source as the writer reads it: its own directory through `ctx.fs`, an alternate through the store's view. */
interface ReadableSource {
  readonly objectsDir: string;
  readonly local: boolean;
  readonly read: (path: string) => Promise<Uint8Array>;
  /** The chain's text, `undefined` when absent. */
  readonly readText: (path: string) => Promise<string | undefined>;
}

const readableSource = (ctx: Context, source: ObjectSource): ReadableSource => {
  const { objectsDir, local } = source;
  if (local) {
    const read = (path: string): Promise<Uint8Array> => ctx.fs.read(path);
    return { objectsDir, local, read, readText: (path) => readUtf8IfPresent(ctx.fs, path) };
  }
  const read = (path: string): Promise<Uint8Array> => source.fs.read(path);
  return { objectsDir, local, read, readText: (path) => source.fs.readUtf8(path) };
};

async function readIfPresent(
  source: ReadableSource,
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    return await source.read(path);
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
}

async function loadLayerFile(
  source: ReadableSource,
  path: string,
): Promise<LocalGraphLayer | undefined> {
  const bytes = await readIfPresent(source, path);
  const layer = bytes === undefined ? undefined : parseLayerOrUndefined(bytes);
  if (layer === undefined) return undefined;
  const hash = ObjectId.fromRaw(layer._bytes.subarray(layer._bytes.length - layer._hashLength));
  return { hash, path, layer, local: source.local };
}

/** A chain under a non-directory `info/commit-graphs` is no chain, as git's open finds none. */
async function readChainIfPresent(source: ReadableSource): Promise<string | undefined> {
  try {
    return await source.readText(commitGraphChainPathIn(source.objectsDir));
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
}

/** git's chain loader: a layer is looked up in every source, the first loadable copy kept. */
async function findLayer(
  sources: readonly ReadableSource[],
  hash: string,
): Promise<LocalGraphLayer | undefined> {
  for (const source of sources) {
    const loaded = await loadLayerFile(source, commitGraphLayerPathIn(source.objectsDir, hash));
    if (loaded !== undefined) return loaded;
  }
  return undefined;
}

async function loadChainLayers(
  sources: readonly ReadableSource[],
  holder: ReadableSource,
): Promise<readonly LocalGraphLayer[]> {
  const chainText = await readChainIfPresent(holder);
  const hashes = (chainText ?? '').split('\n').filter((line) => line.length > 0);
  const layers: LocalGraphLayer[] = [];
  for (const hash of hashes) {
    const loaded = await findLayer(sources, hash);
    if (loaded === undefined) break;
    layers.push(loaded);
  }
  return layers;
}

async function loadSourceLayers(
  sources: readonly ReadableSource[],
  source: ReadableSource,
): Promise<readonly LocalGraphLayer[]> {
  const single = await loadLayerFile(source, commitGraphPathIn(source.objectsDir));
  if (single !== undefined) return source.local ? [single] : [];
  return loadChainLayers(sources, source);
}

export async function loadCommitGraphBaseLayers(ctx: Context): Promise<readonly LocalGraphLayer[]> {
  const sources = (await getObjectStore(ctx)).sources.map((source) => readableSource(ctx, source));
  for (const source of sources) {
    const layers = await loadSourceLayers(sources, source);
    if (layers.length > 0) return layers;
  }
  return [];
}
